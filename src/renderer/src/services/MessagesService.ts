import SearchPopup from '@renderer/components/Popups/SearchPopup'
import { DEFAULT_CONTEXTCOUNT } from '@renderer/config/constant'
import { getTopicById } from '@renderer/hooks/useTopic'
import i18n from '@renderer/i18n'
import { fetchMessagesSummary } from '@renderer/services/ApiService'
import store from '@renderer/store'
import { messageBlocksSelectors, removeManyBlocks, upsertManyBlocks } from '@renderer/store/messageBlock'
import type { Assistant, FileType, Model, Topic } from '@renderer/types'
import { FileTypes } from '@renderer/types'
import type { Message, MessageBlock } from '@renderer/types/newMessageTypes'
import { MessageBlockStatus, MessageBlockType } from '@renderer/types/newMessageTypes'
import { getTitleFromString, uuid } from '@renderer/utils'
import {
  createAssistantMessage,
  createFileBlock,
  createImageBlock,
  createMainTextBlock,
  createMessage
} from '@renderer/utils/messageUtils/create'
import { getMessageContent } from '@renderer/utils/messageUtils/find'
import dayjs from 'dayjs'
import { t } from 'i18next'
import { takeRight } from 'lodash'
import { NavigateFunction } from 'react-router'

import { getAssistantById, getAssistantProvider, getDefaultModel } from './AssistantService'
import { EVENT_NAMES, EventEmitter } from './EventService'
import FileManager from './FileManager'

export {
  filterContextMessages,
  filterEmptyMessages,
  filterMessages,
  filterUsefulMessages,
  filterUserRoleStartMessages
} from '@renderer/utils/messageUtils/filters'

export function getContextCount(assistant: Assistant, messages: Message[]) {
  const rawContextCount = assistant?.settings?.contextCount ?? DEFAULT_CONTEXTCOUNT
  const maxContextCount = rawContextCount === 20 ? 100000 : rawContextCount

  const _messages = rawContextCount === 20 ? takeRight(messages, 1000) : takeRight(messages, maxContextCount)

  const clearIndex = _messages.findLastIndex((message) => message.type === 'clear')

  let currentContextCount = 0
  if (clearIndex === -1) {
    currentContextCount = _messages.length
  } else {
    currentContextCount = _messages.length - (clearIndex + 1)
  }

  return {
    current: currentContextCount,
    max: rawContextCount
  }
}

export function deleteMessageFiles(message: Message) {
  const state = store.getState()
  message.blocks?.forEach((blockId) => {
    const block = messageBlocksSelectors.selectById(state, blockId)
    if (block && (block.type === MessageBlockType.IMAGE || block.type === MessageBlockType.FILE)) {
      const fileData = (block as any).file as FileType | undefined
      if (fileData) {
        FileManager.deleteFiles([fileData])
      }
    }
  })
}

export function isGenerating() {
  return new Promise((resolve, reject) => {
    const generating = store.getState().runtime.generating
    generating && window.message.warning({ content: i18n.t('message.switch.disabled'), key: 'switch-assistant' })
    generating ? reject(false) : resolve(true)
  })
}

export async function locateToMessage(navigate: NavigateFunction, message: Message) {
  await isGenerating()

  SearchPopup.hide()
  const assistant = getAssistantById(message.assistantId)
  const topic = await getTopicById(message.topicId)

  navigate('/', { state: { assistant, topic } })

  setTimeout(() => EventEmitter.emit(EVENT_NAMES.SHOW_TOPIC_SIDEBAR), 0)
  setTimeout(() => EventEmitter.emit(EVENT_NAMES.LOCATE_MESSAGE + ':' + message.id), 300)
}

export function getUserMessage({
  assistant,
  topic,
  type,
  content,
  files
}: {
  assistant: Assistant
  topic: Topic
  type: Message['type']
  content?: string
  files?: FileType[]
}): Message {
  const defaultModel = getDefaultModel()
  const model = assistant.model || defaultModel
  const messageId = uuid()
  const blocks: MessageBlock[] = []
  const blockIds: string[] = []

  if (content?.trim()) {
    const textBlock = createMainTextBlock(messageId, content, { status: MessageBlockStatus.SUCCESS })
    blocks.push(textBlock)
    blockIds.push(textBlock.id)
  }
  if (files?.length) {
    files.forEach((file) => {
      if (file.type === FileTypes.IMAGE) {
        const imgBlock = createImageBlock(messageId, { file, status: MessageBlockStatus.SUCCESS })
        blocks.push(imgBlock)
        blockIds.push(imgBlock.id)
      } else {
        const fileBlock = createFileBlock(messageId, file, { status: MessageBlockStatus.SUCCESS })
        blocks.push(fileBlock)
        blockIds.push(fileBlock.id)
      }
    })
  }

  if (blocks.length > 0) {
    store.dispatch(upsertManyBlocks(blocks))
  }

  return createMessage('user', topic.id, assistant.id, type || 'text', {
    modelId: model?.id,
    model: model,
    blocks: blockIds
  })
}

export function getAssistantMessage({ assistant, topic }: { assistant: Assistant; topic: Topic }): Message {
  const defaultModel = getDefaultModel()
  const model = assistant.model || defaultModel

  return createAssistantMessage(assistant.id, topic, {
    modelId: model?.id,
    model: model
  })
}

export function getMessageModelId(message: Message) {
  return message?.model?.id || message.modelId
}

export function resetAssistantMessage(message: Message, model?: Model): Message {
  const blockIdsToRemove = message.blocks
  if (blockIdsToRemove.length > 0) {
    store.dispatch(removeManyBlocks(blockIdsToRemove))
  }

  return {
    ...message,
    model: model || message.model,
    modelId: model?.id || message.modelId,
    status: 'processing',
    useful: undefined,
    askId: undefined,
    mentions: undefined,
    enabledMCPs: undefined,
    blocks: [],
    createdAt: new Date().toISOString()
  }
}

export async function getMessageTitle(message: Message, length = 30): Promise<string> {
  const content = getMessageContent(message) || ''

  if ((store.getState().settings as any).useTopicNamingForMessageTitle) {
    try {
      window.message.loading({ content: t('chat.topics.export.wait_for_title_naming'), key: 'message-title-naming' })

      const tempTextBlock = createMainTextBlock(message.id, content, { status: MessageBlockStatus.SUCCESS })
      const tempMessage = createMessage(message.role, message.topicId, message.assistantId, message.type, {
        id: message.id,
        createdAt: message.createdAt,
        status: 'success',
        blocks: [tempTextBlock.id]
      })

      const title = await fetchMessagesSummary({ messages: [tempMessage], assistant: {} as Assistant })

      // store.dispatch(messageBlocksActions.upsertOneBlock(tempTextBlock))

      // store.dispatch(messageBlocksActions.removeOneBlock(tempTextBlock.id))

      if (title) {
        window.message.success({ content: t('chat.topics.export.title_naming_success'), key: 'message-title-naming' })
        return title
      }
    } catch (e) {
      window.message.error({ content: t('chat.topics.export.title_naming_failed'), key: 'message-title-naming' })
      console.error('Failed to generate title using topic naming, downgraded to default logic', e)
    }
  }

  let title = getTitleFromString(content, length)

  if (!title) {
    title = dayjs(message.createdAt).format('YYYYMMDDHHmm')
  }

  return title
}

export function checkRateLimit(assistant: Assistant): boolean {
  const provider = getAssistantProvider(assistant)

  if (!provider.rateLimit) {
    return false
  }

  const topicId = assistant.topics[0].id
  const messages = store.getState().messages.messagesByTopic[topicId]

  if (!messages || messages.length <= 1) {
    return false
  }

  const now = Date.now()
  const lastMessage = messages[messages.length - 1]
  const lastMessageTime = new Date(lastMessage.createdAt).getTime()
  const timeDiff = now - lastMessageTime
  const rateLimitMs = provider.rateLimit * 1000

  if (timeDiff < rateLimitMs) {
    const waitTimeSeconds = Math.ceil((rateLimitMs - timeDiff) / 1000)

    window.message.warning({
      content: t('message.warning.rate.limit', { seconds: waitTimeSeconds }),
      duration: 5,
      key: 'rate-limit-message'
    })
    return true
  }

  return false
}
