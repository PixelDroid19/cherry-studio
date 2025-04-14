import {
  ClearOutlined,
  CodeOutlined,
  FileSearchOutlined,
  FormOutlined,
  FullscreenExitOutlined,
  FullscreenOutlined,
  GlobalOutlined,
  HolderOutlined,
  PaperClipOutlined,
  PauseCircleOutlined,
  ThunderboltOutlined,
  TranslationOutlined
} from '@ant-design/icons'
import { QuickPanelListItem, QuickPanelView, useQuickPanel } from '@renderer/components/QuickPanel'
import TranslateButton from '@renderer/components/TranslateButton'
import { isGenerateImageModel, isVisionModel, isWebSearchModel } from '@renderer/config/models'
import db from '@renderer/databases'
import { useAssistant } from '@renderer/hooks/useAssistant'
import { useKnowledgeBases } from '@renderer/hooks/useKnowledge'
import { useMCPServers } from '@renderer/hooks/useMCPServers'
import { useMessageOperations, useTopicLoading } from '@renderer/hooks/useMessageOperations'
import { modelGenerating, useRuntime } from '@renderer/hooks/useRuntime'
import { useMessageStyle, useSettings } from '@renderer/hooks/useSettings'
import { useShortcut, useShortcutDisplay } from '@renderer/hooks/useShortcuts'
import { useSidebarIconShow } from '@renderer/hooks/useSidebarIcon'
import { addAssistantMessagesToTopic, getDefaultTopic } from '@renderer/services/AssistantService'
import { EVENT_NAMES, EventEmitter } from '@renderer/services/EventService'
import FileManager from '@renderer/services/FileManager'
import { checkRateLimit, findMessageById, getUserMessage } from '@renderer/services/MessagesService'
import { getModelUniqId } from '@renderer/services/ModelService'
import { estimateMessageUsage, estimateTextTokens as estimateTxtTokens } from '@renderer/services/TokenService'
import { translateText } from '@renderer/services/TranslateService'
import WebSearchService from '@renderer/services/WebSearchService'
import { useAppDispatch } from '@renderer/store'
import { sendMessage as _sendMessage } from '@renderer/store/messages'
import { setSearching } from '@renderer/store/runtime'
import { Assistant, FileType, KnowledgeBase, KnowledgeItem, MCPServer, Message, Model, Topic } from '@renderer/types'
import { classNames, delay, formatFileSize, getFileExtension } from '@renderer/utils'
import { getFilesFromDropEvent } from '@renderer/utils/input'
import { documentExts, imageExts, textExts } from '@shared/config/constant'
import { Button, Tooltip } from 'antd'
import TextArea, { TextAreaRef } from 'antd/es/input/TextArea'
import dayjs from 'dayjs'
import Logger from 'electron-log/renderer'
import { debounce, isEmpty } from 'lodash'
import React, { CSSProperties, FC, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useNavigate } from 'react-router-dom'
import styled from 'styled-components'

import NarrowLayout from '../Messages/NarrowLayout'
import AttachmentButton, { AttachmentButtonRef } from './AttachmentButton'
import AttachmentPreview from './AttachmentPreview'
import GenerateImageButton from './GenerateImageButton'
import KnowledgeBaseButton, { KnowledgeBaseButtonRef } from './KnowledgeBaseButton'
import KnowledgeBaseInput from './KnowledgeBaseInput'
import MCPToolsButton, { MCPToolsButtonRef } from './MCPToolsButton'
import MentionModelsButton, { MentionModelsButtonRef } from './MentionModelsButton'
import MentionModelsInput from './MentionModelsInput'
import NewContextButton from './NewContextButton'
import QuickPhrasesButton, { QuickPhrasesButtonRef } from './QuickPhrasesButton'
import SendMessageButton from './SendMessageButton'
import TokenCount from './TokenCount'

interface Props {
  assistant: Assistant
  setActiveTopic: (topic: Topic) => void
  topic: Topic
}

let _text = ''
let _files: FileType[] = []

const Inputbar: FC<Props> = ({ assistant: _assistant, setActiveTopic, topic }) => {
  const [text, setText] = useState(_text)
  const [inputFocus, setInputFocus] = useState(false)
  const { assistant, addTopic, model, setModel, updateAssistant } = useAssistant(_assistant.id)
  const {
    targetLanguage,
    sendMessageShortcut,
    fontSize,
    pasteLongTextAsFile,
    pasteLongTextThreshold,
    showInputEstimatedTokens,
    autoTranslateWithSpace,
    enableQuickPanelTriggers
  } = useSettings()
  const [expended, setExpend] = useState(false)
  const [estimateTokenCount, setEstimateTokenCount] = useState(0)
  const [contextCount, setContextCount] = useState({ current: 0, max: 0 })
  const textareaRef = useRef<TextAreaRef>(null)
  const [files, setFiles] = useState<FileType[]>(_files)
  const { t } = useTranslation()
  const containerRef = useRef(null)
  const { searching } = useRuntime()
  const { isBubbleStyle } = useMessageStyle()
  const { pauseMessages } = useMessageOperations(topic)
  const loading = useTopicLoading(topic)
  const dispatch = useAppDispatch()
  const [spaceClickCount, setSpaceClickCount] = useState(0)
  const spaceClickTimer = useRef<NodeJS.Timeout>(null)
  const [isTranslating, setIsTranslating] = useState(false)
  const [selectedKnowledgeBases, setSelectedKnowledgeBases] = useState<KnowledgeBase[]>([])
  const [mentionModels, setMentionModels] = useState<Model[]>([])
  const [enabledMCPs, setEnabledMCPs] = useState<MCPServer[]>(assistant.mcpServers || [])
  const [isDragging, setIsDragging] = useState(false)
  const [textareaHeight, setTextareaHeight] = useState<number>()
  const startDragY = useRef<number>(0)
  const startHeight = useRef<number>(0)
  const currentMessageId = useRef<string>('')
  const isVision = useMemo(() => isVisionModel(model), [model])
  const supportExts = useMemo(() => [...textExts, ...documentExts, ...(isVision ? imageExts : [])], [isVision])
  const navigate = useNavigate()
  const { activedMcpServers } = useMCPServers()
  const { bases: knowledgeBases } = useKnowledgeBases()

  const quickPanel = useQuickPanel()

  const showKnowledgeIcon = useSidebarIconShow('knowledge')
  // const showMCPToolsIcon = isFunctionCallingModel(model)

  const [tokenCount, setTokenCount] = useState(0)

  const quickPhrasesButtonRef = useRef<QuickPhrasesButtonRef>(null)
  const mentionModelsButtonRef = useRef<MentionModelsButtonRef>(null)
  const knowledgeBaseButtonRef = useRef<KnowledgeBaseButtonRef>(null)
  const mcpToolsButtonRef = useRef<MCPToolsButtonRef>(null)
  const attachmentButtonRef = useRef<AttachmentButtonRef>(null)

  // eslint-disable-next-line react-hooks/exhaustive-deps
  const debouncedEstimate = useCallback(
    debounce((newText) => {
      if (showInputEstimatedTokens) {
        const count = estimateTxtTokens(newText) || 0
        setTokenCount(count)
      }
    }, 500),
    [showInputEstimatedTokens]
  )

  useEffect(() => {
    debouncedEstimate(text)
  }, [text, debouncedEstimate])

  const inputTokenCount = showInputEstimatedTokens ? tokenCount : 0

  const newTopicShortcut = useShortcutDisplay('new_topic')
  const cleanTopicShortcut = useShortcutDisplay('clear_topic')
  const inputEmpty = isEmpty(text.trim()) && files.length === 0

  _text = text
  _files = files

  const resizeTextArea = useCallback(() => {
    const textArea = textareaRef.current?.resizableTextArea?.textArea
    if (textArea) {
      // 如果已经手动设置了高度,则不自动调整
      if (textareaHeight) {
        return
      }
      textArea.style.height = 'auto'
      textArea.style.height = textArea?.scrollHeight > 400 ? '400px' : `${textArea?.scrollHeight}px`
    }
  }, [textareaHeight])

  // Reset to assistant knowledge mcp servers
  useEffect(() => {
    setEnabledMCPs(assistant.mcpServers || [])
  }, [assistant.mcpServers])

  const sendMessage = useCallback(async () => {
    if (inputEmpty || loading) {
      return
    }
    if (checkRateLimit(assistant)) {
      return
    }

    EventEmitter.emit(EVENT_NAMES.SEND_MESSAGE)

    try {
      // 检查用户输入是否包含消息ID
      const uuidRegex = /[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}/i

      // 从文本中提取所有消息ID
      const matches = text.match(new RegExp(uuidRegex, 'g'))

      // 如果只有ID且没有其他内容，则直接查找原始消息
      if (matches && matches.length > 0 && text.trim() === matches.join(' ')) {
        try {
          // 创建引用消息
          const userMessage = getUserMessage({ assistant, topic, type: 'text', content: '' })
          userMessage.referencedMessages = []

          // 处理所有匹配到的ID
          let foundAnyMessage = false
          for (const messageId of matches) {
            console.log(`[引用消息] 尝试查找消息ID: ${messageId}`)
            const originalMessage = await findMessageById(messageId)
            if (originalMessage) {
              userMessage.referencedMessages.push({
                id: originalMessage.id,
                content: originalMessage.content,
                role: originalMessage.role,
                createdAt: originalMessage.createdAt
              })
              foundAnyMessage = true
              console.log(`[引用消息] 找到消息ID: ${messageId}`)
            } else {
              console.log(`[引用消息] 未找到消息ID: ${messageId}`)
            }
          }

          if (foundAnyMessage) {
            // 发送引用消息
            userMessage.usage = await estimateMessageUsage(userMessage)
            currentMessageId.current = userMessage.id

            dispatch(
              _sendMessage(userMessage, assistant, topic, {
                mentions: mentionModels
              })
            )

            // 清空输入框
            setText('')
            setFiles([])
            setTimeout(() => setText(''), 500)
            setTimeout(() => resizeTextArea(), 0)
            setExpend(false)

            window.message.success({
              content:
                t('message.ids_found', { count: userMessage.referencedMessages.length }) ||
                `已找到${userMessage.referencedMessages.length}条原始消息`,
              key: 'message-id-found'
            })
            return
          } else {
            window.message.error({
              content: t('message.id_not_found') || '未找到原始消息',
              key: 'message-id-not-found'
            })
          }
        } catch (error) {
          console.error(`[引用消息] 查找消息ID时出错:`, error)
          window.message.error({ content: t('message.id_error') || '查找原始消息时出错', key: 'message-id-error' })
        }
      }

      // 如果不是单独的ID或者没有找到原始消息，则正常发送消息
      // 先检查消息内容是否包含消息ID，如果是则将其替换为空字符串
      let messageContent = text

      // 如果消息内容包含消息ID，则将其替换为空字符串
      if (matches && matches.length > 0) {
        // 检查是否是纯消息ID
        const isOnlyUUID = text.trim() === matches[0]
        if (isOnlyUUID) {
          messageContent = ''
        } else {
          // 如果消息内容包含消息ID，则将消息ID替换为空字符串
          for (const match of matches) {
            messageContent = messageContent.replace(match, '')
          }
          // 去除多余的空格
          messageContent = messageContent.replace(/\s+/g, ' ').trim()
        }
      }

      // Dispatch the sendMessage action with all options
      const uploadedFiles = await FileManager.uploadFiles(files)
      const userMessage = getUserMessage({ assistant, topic, type: 'text', content: messageContent })

      // 如果消息内容包含消息ID，则添加引用
      if (matches && matches.length > 0) {
        try {
          // 初始化引用消息数组
          userMessage.referencedMessages = []

          // 处理所有匹配到的ID
          for (const messageId of matches) {
            console.log(`[引用消息] 尝试查找消息ID作为引用: ${messageId}`)
            const originalMessage = await findMessageById(messageId)
            if (originalMessage) {
              userMessage.referencedMessages.push({
                id: originalMessage.id,
                content: originalMessage.content,
                role: originalMessage.role,
                createdAt: originalMessage.createdAt
              })
              console.log(`[引用消息] 找到消息ID作为引用: ${messageId}`)
            } else {
              console.log(`[引用消息] 未找到消息ID作为引用: ${messageId}`)
            }
          }

          // 如果找到了引用消息，显示成功提示
          if (userMessage.referencedMessages.length > 0) {
            window.message.success({
              content:
                t('message.ids_found', { count: userMessage.referencedMessages.length }) ||
                `已找到${userMessage.referencedMessages.length}条原始消息`,
              key: 'message-id-found'
            })
          }
        } catch (error) {
          console.error(`[引用消息] 查找消息ID作为引用时出错:`, error)
        }
      }

      if (uploadedFiles) {
        userMessage.files = uploadedFiles
      }

      const knowledgeBaseIds = selectedKnowledgeBases?.map((base) => base.id)

      if (knowledgeBaseIds) {
        userMessage.knowledgeBaseIds = knowledgeBaseIds
      }

      if (mentionModels) {
        userMessage.mentions = mentionModels
      }

      if (!isEmpty(enabledMCPs) && !isEmpty(activedMcpServers)) {
        userMessage.enabledMCPs = activedMcpServers.filter((server) => enabledMCPs?.some((s) => s.id === server.id))
      }

      userMessage.usage = await estimateMessageUsage(userMessage)
      currentMessageId.current = userMessage.id

      dispatch(
        _sendMessage(userMessage, assistant, topic, {
          mentions: mentionModels
        })
      )

      // Clear input
      setText('')
      setFiles([])
      setTimeout(() => setText(''), 500)
      setTimeout(() => resizeTextArea(), 0)
      setExpend(false)
    } catch (error) {
      console.error('Failed to send message:', error)
    }
  }, [
    assistant,
    dispatch,
    enabledMCPs,
    files,
    inputEmpty,
    loading,
    mentionModels,
    resizeTextArea,
    selectedKnowledgeBases,
    text,
    topic,
    activedMcpServers
  ])

  const translate = useCallback(async () => {
    if (isTranslating) {
      return
    }

    try {
      setIsTranslating(true)
      const translatedText = await translateText(text, targetLanguage)
      translatedText && setText(translatedText)
      setTimeout(() => resizeTextArea(), 0)
    } catch (error) {
      console.error('Translation failed:', error)
    } finally {
      setIsTranslating(false)
    }
  }, [isTranslating, text, targetLanguage, resizeTextArea])

  const openKnowledgeFileList = useCallback(
    (base: KnowledgeBase) => {
      quickPanel.open({
        title: base.name,
        list: base.items
          .filter((file): file is KnowledgeItem => ['file'].includes(file.type))
          .map((file) => {
            const fileContent = file.content as FileType
            return {
              label: fileContent.origin_name || fileContent.name,
              description:
                formatFileSize(fileContent.size) + ' · ' + dayjs(fileContent.created_at).format('YYYY-MM-DD HH:mm'),
              icon: <FileSearchOutlined />,
              isSelected: files.some((f) => f.path === fileContent.path),
              action: async ({ item }) => {
                item.isSelected = !item.isSelected
                if (fileContent.path) {
                  setFiles((prevFiles) => {
                    const fileExists = prevFiles.some((f) => f.path === fileContent.path)
                    if (fileExists) {
                      return prevFiles.filter((f) => f.path !== fileContent.path)
                    } else {
                      return fileContent ? [...prevFiles, fileContent] : prevFiles
                    }
                  })
                }
              }
            }
          }),
        symbol: 'file',
        multiple: true
      })
    },
    [files, quickPanel]
  )

  const openSelectFileMenu = useCallback(() => {
    quickPanel.open({
      title: t('chat.input.upload'),
      list: [
        {
          label: t('chat.input.upload.upload_from_local'),
          description: '',
          icon: <PaperClipOutlined />,
          action: () => {
            attachmentButtonRef.current?.openQuickPanel()
          }
        },
        ...knowledgeBases.map((base) => {
          const length = base.items?.filter(
            (item): item is KnowledgeItem => ['file', 'note'].includes(item.type) && typeof item.content !== 'string'
          ).length
          return {
            label: base.name,
            description: `${length} ${t('files.count')}`,
            icon: <FileSearchOutlined />,
            disabled: length === 0,
            isMenu: true,
            action: () => openKnowledgeFileList(base)
          }
        })
      ],
      symbol: 'file'
    })
  }, [knowledgeBases, openKnowledgeFileList, quickPanel, t])

  const quickPanelMenu = useMemo<QuickPanelListItem[]>(() => {
    return [
      {
        label: t('settings.quickPhrase.title'),
        description: '',
        icon: <ThunderboltOutlined />,
        isMenu: true,
        action: () => {
          quickPhrasesButtonRef.current?.openQuickPanel()
        }
      },
      {
        label: t('agents.edit.model.select.title'),
        description: '',
        icon: '@',
        isMenu: true,
        action: () => {
          mentionModelsButtonRef.current?.openQuickPanel()
        }
      },
      {
        label: t('chat.input.knowledge_base'),
        description: '',
        icon: <FileSearchOutlined />,
        isMenu: true,
        disabled: files.length > 0,
        action: () => {
          knowledgeBaseButtonRef.current?.openQuickPanel()
        }
      },
      {
        label: t('settings.mcp.title'),
        description: t('settings.mcp.not_support'),
        icon: <CodeOutlined />,
        isMenu: true,
        action: () => {
          mcpToolsButtonRef.current?.openQuickPanel()
        }
      },
      {
        label: 'MCP Prompt',
        description: '',
        icon: <CodeOutlined />,
        isMenu: true,
        action: () => {
          mcpToolsButtonRef.current?.openPromptList()
        }
      },
      {
        label: isVisionModel(model) ? t('chat.input.upload') : t('chat.input.upload.document'),
        description: '',
        icon: <PaperClipOutlined />,
        isMenu: true,
        action: openSelectFileMenu
      },
      {
        label: t('translate.title'),
        description: t('translate.menu.description'),
        icon: <TranslationOutlined />,
        action: () => {
          if (!text) return
          translate()
        }
      }
    ]
  }, [files.length, model, openSelectFileMenu, t, text, translate])

  const handleKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    const isEnterPressed = event.keyCode == 13

    // 检查是否是消息ID格式
    if (isEnterPressed && !event.shiftKey) {
      const uuidRegex = /[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}/i
      const currentText = text.trim()
      const isUUID = uuidRegex.test(currentText) && currentText.length === 36

      if (isUUID) {
        // 如果是消息ID格式，则不显示ID在对话中
        event.preventDefault()
        sendMessage()
        return
      }
    }

    // 按下Tab键，自动选中${xxx}
    if (event.key === 'Tab' && inputFocus) {
      event.preventDefault()
      const textArea = textareaRef.current?.resizableTextArea?.textArea
      if (!textArea) return

      const cursorPosition = textArea.selectionStart
      const selectionLength = textArea.selectionEnd - textArea.selectionStart
      const text = textArea.value

      let match = text.slice(cursorPosition + selectionLength).match(/\$\{[^}]+\}/)
      let startIndex = -1

      if (!match) {
        match = text.match(/\$\{[^}]+\}/)
        startIndex = match?.index ?? -1
      } else {
        startIndex = cursorPosition + selectionLength + match.index!
      }

      if (startIndex !== -1) {
        const endIndex = startIndex + match![0].length
        textArea.setSelectionRange(startIndex, endIndex)
        return
      }
    }

    if (autoTranslateWithSpace) {
      if (event.key === ' ') {
        setSpaceClickCount((prev) => prev + 1)

        if (spaceClickTimer.current) {
          clearTimeout(spaceClickTimer.current)
        }

        spaceClickTimer.current = setTimeout(() => {
          setSpaceClickCount(0)
        }, 200)

        if (spaceClickCount === 2) {
          console.log('Triple space detected - trigger translation')
          setSpaceClickCount(0)
          setIsTranslating(true)
          translate()
          return
        }
      }
    }

    if (expended) {
      if (event.key === 'Escape') {
        return onToggleExpended()
      }
    }

    if (isEnterPressed && !event.shiftKey && sendMessageShortcut === 'Enter') {
      if (quickPanel.isVisible) return event.preventDefault()

      sendMessage()
      return event.preventDefault()
    }

    if (sendMessageShortcut === 'Shift+Enter' && isEnterPressed && event.shiftKey) {
      if (quickPanel.isVisible) return event.preventDefault()

      sendMessage()
      return event.preventDefault()
    }

    if (sendMessageShortcut === 'Ctrl+Enter' && isEnterPressed && event.ctrlKey) {
      if (quickPanel.isVisible) return event.preventDefault()

      sendMessage()
      return event.preventDefault()
    }

    if (sendMessageShortcut === 'Command+Enter' && isEnterPressed && event.metaKey) {
      if (quickPanel.isVisible) return event.preventDefault()

      sendMessage()
      return event.preventDefault()
    }

    if (event.key === 'Backspace' && text.trim() === '' && mentionModels.length > 0) {
      setMentionModels((prev) => prev.slice(0, -1))
      return event.preventDefault()
    }

    if (event.key === 'Backspace' && text.trim() === '' && selectedKnowledgeBases.length > 0) {
      setSelectedKnowledgeBases((prev) => {
        const newSelectedKnowledgeBases = prev.slice(0, -1)
        updateAssistant({ ...assistant, knowledge_bases: newSelectedKnowledgeBases })
        return newSelectedKnowledgeBases
      })
      return event.preventDefault()
    }

    if (event.key === 'Backspace' && text.trim() === '' && files.length > 0) {
      setFiles((prev) => prev.slice(0, -1))
      return event.preventDefault()
    }
  }

  const addNewTopic = useCallback(async () => {
    await modelGenerating()

    const topic = getDefaultTopic(assistant.id)

    await db.topics.add({ id: topic.id, messages: [] })
    await addAssistantMessagesToTopic({ assistant, topic })

    // Clear previous state
    // Reset to assistant default model
    assistant.defaultModel && setModel(assistant.defaultModel)

    // Reset to assistant knowledge mcp servers
    !isEmpty(assistant.mcpServers) && setEnabledMCPs(assistant.mcpServers || [])

    addTopic(topic)
    setActiveTopic(topic)

    setTimeout(() => EventEmitter.emit(EVENT_NAMES.SHOW_TOPIC_SIDEBAR), 0)
  }, [addTopic, assistant, setActiveTopic, setModel])

  const onPause = async () => {
    await pauseMessages()
  }

  const clearTopic = async () => {
    if (loading) {
      await onPause()
      await delay(1)
    }
    EventEmitter.emit(EVENT_NAMES.CLEAR_MESSAGES)
  }

  const onNewContext = () => {
    if (loading) {
      onPause()
      return
    }
    EventEmitter.emit(EVENT_NAMES.NEW_CONTEXT)
  }

  const onInput = () => !expended && resizeTextArea()

  const onChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const newText = e.target.value

    // 检查是否包含UUID格式的消息ID
    const uuidRegex = /[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}/i
    const matches = newText.match(new RegExp(uuidRegex, 'g'))

    // 如果输入的内容只是一个UUID，不更新文本框内容，直接处理引用
    if (matches && matches.length === 1 && newText.trim() === matches[0]) {
      // 不立即更新文本框，等待用户按下回车键时再处理
      setText(newText)
    } else {
      // 正常更新文本框内容
      setText(newText)
    }

    const textArea = textareaRef.current?.resizableTextArea?.textArea
    const cursorPosition = textArea?.selectionStart ?? 0
    const lastSymbol = newText[cursorPosition - 1]

    if (enableQuickPanelTriggers && !quickPanel.isVisible && lastSymbol === '/') {
      quickPanel.open({
        title: t('settings.quickPanel.title'),
        list: quickPanelMenu,
        symbol: '/'
      })
    }

    if (enableQuickPanelTriggers && !quickPanel.isVisible && lastSymbol === '@') {
      mentionModelsButtonRef.current?.openQuickPanel()
    }
  }

  const onPaste = useCallback(
    async (event: ClipboardEvent) => {
      const clipboardText = event.clipboardData?.getData('text')
      if (clipboardText) {
        // 检查粘贴的内容是否是消息ID
        const uuidRegex = /[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}/i
        const isUUID = uuidRegex.test(clipboardText.trim()) && clipboardText.trim().length === 36

        if (isUUID) {
          // 如果是消息ID，则阻止默认粘贴行为，自定义处理
          event.preventDefault()

          // 获取当前文本框的内容和光标位置
          const textArea = textareaRef.current?.resizableTextArea?.textArea
          if (textArea) {
            const currentText = textArea.value
            const cursorPosition = textArea.selectionStart
            const cursorEnd = textArea.selectionEnd

            // 如果有选中文本，则替换选中文本；否则在光标位置插入
            const newText =
              currentText.substring(0, cursorPosition) + clipboardText.trim() + currentText.substring(cursorEnd)

            setText(newText)

            // 将光标移到插入的ID后面
            const newCursorPosition = cursorPosition + clipboardText.trim().length
            setTimeout(() => {
              if (textArea) {
                textArea.focus()
                textArea.setSelectionRange(newCursorPosition, newCursorPosition)
              }
            }, 0)
          } else {
            // 如果无法获取textArea，则直接设置文本
            setText(clipboardText.trim())
          }
        }
        // 其他文本内容由默认事件处理
      } else {
        for (const file of event.clipboardData?.files || []) {
          event.preventDefault()

          if (file.path === '') {
            if (file.type.startsWith('image/') && isVisionModel(model)) {
              const tempFilePath = await window.api.file.create(file.name)
              const arrayBuffer = await file.arrayBuffer()
              const uint8Array = new Uint8Array(arrayBuffer)
              await window.api.file.write(tempFilePath, uint8Array)
              const selectedFile = await window.api.file.get(tempFilePath)
              selectedFile && setFiles((prevFiles) => [...prevFiles, selectedFile])
              break
            } else {
              window.message.info({
                key: 'file_not_supported',
                content: t('chat.input.file_not_supported')
              })
            }
          }

          if (file.path) {
            if (supportExts.includes(getFileExtension(file.path))) {
              const selectedFile = await window.api.file.get(file.path)
              selectedFile && setFiles((prevFiles) => [...prevFiles, selectedFile])
            } else {
              window.message.info({
                key: 'file_not_supported',
                content: t('chat.input.file_not_supported')
              })
            }
          }
        }
      }

      if (pasteLongTextAsFile) {
        const item = event.clipboardData?.items[0]
        if (item && item.kind === 'string' && item.type === 'text/plain') {
          item.getAsString(async (pasteText) => {
            if (pasteText.length > pasteLongTextThreshold) {
              const tempFilePath = await window.api.file.create('pasted_text.txt')
              await window.api.file.write(tempFilePath, pasteText)
              const selectedFile = await window.api.file.get(tempFilePath)
              selectedFile && setFiles((prevFiles) => [...prevFiles, selectedFile])
              setText(text)
              setTimeout(() => resizeTextArea(), 50)
            }
          })
        }
      }
    },
    [model, pasteLongTextAsFile, pasteLongTextThreshold, resizeTextArea, supportExts, t, text]
  )

  const handleDragOver = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault()
    e.stopPropagation()
  }

  const handleDrop = async (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault()
    e.stopPropagation()

    const files = await getFilesFromDropEvent(e).catch((err) => {
      Logger.error('[src/renderer/src/pages/home/Inputbar/Inputbar.tsx] handleDrop:', err)
      return null
    })

    if (files) {
      files.forEach((file) => {
        if (supportExts.includes(getFileExtension(file.path))) {
          setFiles((prevFiles) => [...prevFiles, file])
        }
      })
    }
  }

  const onTranslated = (translatedText: string) => {
    setText(translatedText)
    setTimeout(() => resizeTextArea(), 0)
  }

  const handleDragStart = (e: React.MouseEvent) => {
    e.preventDefault()
    setIsDragging(true)
    startDragY.current = e.clientY
    const textArea = textareaRef.current?.resizableTextArea?.textArea
    if (textArea) {
      startHeight.current = textArea.offsetHeight
    }
  }

  const handleDrag = useCallback(
    (e: MouseEvent) => {
      if (!isDragging) return

      const delta = startDragY.current - e.clientY // 改变计算方向
      const viewportHeight = window.innerHeight
      const maxHeightInPixels = viewportHeight * 0.7

      const newHeight = Math.min(maxHeightInPixels, Math.max(startHeight.current + delta, 30))
      const textArea = textareaRef.current?.resizableTextArea?.textArea

      if (textArea) {
        textArea.style.height = `${newHeight}px`
        setExpend(newHeight == maxHeightInPixels)
        setTextareaHeight(newHeight)
      }
    },
    [isDragging]
  )

  const handleDragEnd = useCallback(() => {
    setIsDragging(false)
  }, [])

  useEffect(() => {
    if (isDragging) {
      document.addEventListener('mousemove', handleDrag)
      document.addEventListener('mouseup', handleDragEnd)
    }
    return () => {
      document.removeEventListener('mousemove', handleDrag)
      document.removeEventListener('mouseup', handleDragEnd)
    }
  }, [isDragging, handleDrag, handleDragEnd])

  useShortcut('new_topic', () => {
    addNewTopic()
    EventEmitter.emit(EVENT_NAMES.SHOW_TOPIC_SIDEBAR)
    textareaRef.current?.focus()
  })

  useShortcut('clear_topic', clearTopic)

  useEffect(() => {
    const _setEstimateTokenCount = debounce(setEstimateTokenCount, 100, { leading: false, trailing: true })
    const unsubscribes = [
      EventEmitter.on(EVENT_NAMES.EDIT_MESSAGE, (message: Message) => {
        setText(message.content)
        textareaRef.current?.focus()
        setTimeout(() => resizeTextArea(), 0)
      }),
      EventEmitter.on(EVENT_NAMES.ESTIMATED_TOKEN_COUNT, ({ tokensCount, contextCount }) => {
        _setEstimateTokenCount(tokensCount)
        setContextCount({ current: contextCount.current, max: contextCount.max }) // 现在contextCount是一个对象而不是单个数值
      }),
      EventEmitter.on(EVENT_NAMES.ADD_NEW_TOPIC, addNewTopic),
      EventEmitter.on(EVENT_NAMES.QUOTE_TEXT, (quotedText: string) => {
        setText((prevText) => {
          const newText = prevText ? `${prevText}\n${quotedText}\n` : `${quotedText}\n`
          setTimeout(() => resizeTextArea(), 0)
          return newText
        })
        textareaRef.current?.focus()
      })
    ]
    return () => unsubscribes.forEach((unsub) => unsub())
  }, [addNewTopic, resizeTextArea])

  useEffect(() => {
    textareaRef.current?.focus()
  }, [assistant])

  useEffect(() => {
    setTimeout(() => resizeTextArea(), 0)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    return () => {
      if (spaceClickTimer.current) {
        clearTimeout(spaceClickTimer.current)
      }
    }
  }, [])

  useEffect(() => {
    window.addEventListener('focus', () => {
      textareaRef.current?.focus()
    })
  }, [])

  useEffect(() => {
    // if assistant knowledge bases are undefined return []
    setSelectedKnowledgeBases(showKnowledgeIcon ? (assistant.knowledge_bases ?? []) : [])
  }, [assistant.id, assistant.knowledge_bases, showKnowledgeIcon])

  const textareaRows = window.innerHeight >= 1000 || isBubbleStyle ? 2 : 1

  const handleKnowledgeBaseSelect = (bases?: KnowledgeBase[]) => {
    updateAssistant({ ...assistant, knowledge_bases: bases })
    setSelectedKnowledgeBases(bases ?? [])
  }

  const handleRemoveModel = (model: Model) => {
    setMentionModels(mentionModels.filter((m) => m.id !== model.id))
  }

  const handleRemoveKnowledgeBase = (knowledgeBase: KnowledgeBase) => {
    const newKnowledgeBases = assistant.knowledge_bases?.filter((kb) => kb.id !== knowledgeBase.id)
    updateAssistant({
      ...assistant,
      knowledge_bases: newKnowledgeBases
    })
    setSelectedKnowledgeBases(newKnowledgeBases ?? [])
  }

  const toggelEnableMCP = (mcp: MCPServer) => {
    setEnabledMCPs((prev) => {
      const exists = prev.some((item) => item.id === mcp.id)
      if (exists) {
        return prev.filter((item) => item.id !== mcp.id)
      } else {
        return [...prev, mcp]
      }
    })
  }

  const showWebSearchEnableModal = () => {
    window.modal.confirm({
      title: t('chat.input.web_search.enable'),
      content: t('chat.input.web_search.enable_content'),
      centered: true,
      okText: t('chat.input.web_search.button.ok'),
      onOk: () => {
        navigate('/settings/web-search')
      }
    })
  }

  const shouldShowEnableModal = () => {
    // 网络搜索功能是否未启用
    const webSearchNotEnabled = !WebSearchService.isWebSearchEnabled()
    // 非网络搜索模型：仅当网络搜索功能未启用时显示启用提示
    if (!isWebSearchModel(model)) {
      return webSearchNotEnabled
    }
    // 网络搜索模型：当允许覆盖但网络搜索功能未启用时显示启用提示
    return WebSearchService.isOverwriteEnabled() && webSearchNotEnabled
  }

  const onEnableWebSearch = () => {
    if (shouldShowEnableModal()) {
      showWebSearchEnableModal()
      return
    }

    updateAssistant({ ...assistant, enableWebSearch: !assistant.enableWebSearch })
  }

  const onEnableGenerateImage = () => {
    updateAssistant({ ...assistant, enableGenerateImage: !assistant.enableGenerateImage })
  }

  useEffect(() => {
    if (!isWebSearchModel(model) && !WebSearchService.isWebSearchEnabled() && assistant.enableWebSearch) {
      updateAssistant({ ...assistant, enableWebSearch: false })
    }
    if (!isGenerateImageModel(model) && assistant.enableGenerateImage) {
      updateAssistant({ ...assistant, enableGenerateImage: false })
    }
  }, [assistant, model, updateAssistant])

  const onMentionModel = (model: Model) => {
    setMentionModels((prev) => {
      const modelId = getModelUniqId(model)
      const exists = prev.some((m) => getModelUniqId(m) === modelId)
      return exists ? prev.filter((m) => getModelUniqId(m) !== modelId) : [...prev, model]
    })
  }

  const onToggleExpended = () => {
    if (textareaHeight) {
      const textArea = textareaRef.current?.resizableTextArea?.textArea
      if (textArea) {
        textArea.style.height = 'auto'
        setTextareaHeight(undefined)
        setTimeout(() => {
          textArea.style.height = `${textArea.scrollHeight}px`
        }, 200)
        return
      }
    }

    const isExpended = !expended
    setExpend(isExpended)
    const textArea = textareaRef.current?.resizableTextArea?.textArea

    if (textArea) {
      if (isExpended) {
        textArea.style.height = '70vh'
      } else {
        resetHeight()
      }
    }

    textareaRef.current?.focus()
  }

  const resetHeight = () => {
    if (expended) {
      setExpend(false)
    }

    setTextareaHeight(undefined)

    requestAnimationFrame(() => {
      const textArea = textareaRef.current?.resizableTextArea?.textArea
      if (textArea) {
        textArea.style.height = 'auto'
        const contentHeight = textArea.scrollHeight
        textArea.style.height = contentHeight > 400 ? '400px' : `${contentHeight}px`
      }
    })
  }

  const isExpended = expended || !!textareaHeight

  return (
    <Container onDragOver={handleDragOver} onDrop={handleDrop} className="inputbar">
      <NarrowLayout style={{ width: '100%' }}>
        <QuickPanelView setInputText={setText} />
        <InputBarContainer
          id="inputbar"
          className={classNames('inputbar-container', inputFocus && 'focus')}
          ref={containerRef}>
          {files.length > 0 && <AttachmentPreview files={files} setFiles={setFiles} />}
          {selectedKnowledgeBases.length > 0 && (
            <KnowledgeBaseInput
              selectedKnowledgeBases={selectedKnowledgeBases}
              onRemoveKnowledgeBase={handleRemoveKnowledgeBase}
            />
          )}
          {mentionModels.length > 0 && (
            <MentionModelsInput selectedModels={mentionModels} onRemoveModel={handleRemoveModel} />
          )}
          <Textarea
            value={text}
            onChange={onChange}
            onKeyDown={handleKeyDown}
            placeholder={isTranslating ? t('chat.input.translating') : t('chat.input.placeholder')}
            autoFocus
            contextMenu="true"
            variant="borderless"
            spellCheck={false}
            rows={textareaRows}
            ref={textareaRef}
            style={{
              fontSize,
              minHeight: textareaHeight ? `${textareaHeight}px` : undefined
            }}
            styles={{ textarea: TextareaStyle }}
            onFocus={(e: React.FocusEvent<HTMLTextAreaElement>) => {
              setInputFocus(true)
              const textArea = e.target
              if (textArea) {
                const length = textArea.value.length
                textArea.setSelectionRange(length, length)
              }
            }}
            onBlur={() => setInputFocus(false)}
            onInput={onInput}
            disabled={searching}
            onPaste={(e) => onPaste(e.nativeEvent)}
            onClick={() => searching && dispatch(setSearching(false))}
          />
          <DragHandle onMouseDown={handleDragStart}>
            <HolderOutlined />
          </DragHandle>
          <Toolbar>
            <ToolbarMenu>
              <Tooltip placement="top" title={t('chat.input.new_topic', { Command: newTopicShortcut })} arrow>
                <ToolbarButton type="text" onClick={addNewTopic}>
                  <FormOutlined />
                </ToolbarButton>
              </Tooltip>
              <AttachmentButton
                ref={attachmentButtonRef}
                model={model}
                files={files}
                setFiles={setFiles}
                ToolbarButton={ToolbarButton}
              />
              <Tooltip placement="top" title={t('chat.input.web_search')} arrow>
                <ToolbarButton type="text" onClick={onEnableWebSearch}>
                  <GlobalOutlined
                    style={{ color: assistant.enableWebSearch ? 'var(--color-link)' : 'var(--color-icon)' }}
                  />
                </ToolbarButton>
              </Tooltip>
              {showKnowledgeIcon && (
                <KnowledgeBaseButton
                  ref={knowledgeBaseButtonRef}
                  selectedBases={selectedKnowledgeBases}
                  onSelect={handleKnowledgeBaseSelect}
                  ToolbarButton={ToolbarButton}
                  disabled={files.length > 0}
                />
              )}
              <MCPToolsButton
                ref={mcpToolsButtonRef}
                enabledMCPs={enabledMCPs}
                toggelEnableMCP={toggelEnableMCP}
                ToolbarButton={ToolbarButton}
                setInputValue={setText}
                resizeTextArea={resizeTextArea}
              />
              <GenerateImageButton
                model={model}
                assistant={assistant}
                onEnableGenerateImage={onEnableGenerateImage}
                ToolbarButton={ToolbarButton}
              />
              <MentionModelsButton
                ref={mentionModelsButtonRef}
                mentionModels={mentionModels}
                onMentionModel={onMentionModel}
                ToolbarButton={ToolbarButton}
              />
              <QuickPhrasesButton
                ref={quickPhrasesButtonRef}
                setInputValue={setText}
                resizeTextArea={resizeTextArea}
                ToolbarButton={ToolbarButton}
              />
              <Tooltip placement="top" title={t('chat.input.clear', { Command: cleanTopicShortcut })} arrow>
                <ToolbarButton type="text" onClick={clearTopic}>
                  <ClearOutlined style={{ fontSize: 17 }} />
                </ToolbarButton>
              </Tooltip>
              <Tooltip placement="top" title={isExpended ? t('chat.input.collapse') : t('chat.input.expand')} arrow>
                <ToolbarButton type="text" onClick={onToggleExpended}>
                  {isExpended ? <FullscreenExitOutlined /> : <FullscreenOutlined />}
                </ToolbarButton>
              </Tooltip>
              <NewContextButton onNewContext={onNewContext} ToolbarButton={ToolbarButton} />
              <TokenCount
                estimateTokenCount={estimateTokenCount}
                inputTokenCount={inputTokenCount}
                contextCount={contextCount}
                ToolbarButton={ToolbarButton}
                onClick={onNewContext}
              />
            </ToolbarMenu>
            <ToolbarMenu>
              <TranslateButton text={text} onTranslated={onTranslated} isLoading={isTranslating} />
              {loading && (
                <Tooltip placement="top" title={t('chat.input.pause')} arrow>
                  <ToolbarButton type="text" onClick={onPause} style={{ marginRight: -2, marginTop: 1 }}>
                    <PauseCircleOutlined style={{ color: 'var(--color-error)', fontSize: 20 }} />
                  </ToolbarButton>
                </Tooltip>
              )}
              {!loading && <SendMessageButton sendMessage={sendMessage} disabled={loading || inputEmpty} />}
            </ToolbarMenu>
          </Toolbar>
        </InputBarContainer>
      </NarrowLayout>
    </Container>
  )
}

// Add these styled components at the bottom
const DragHandle = styled.div`
  position: absolute;
  top: -3px;
  left: 0;
  right: 0;
  height: 6px;
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: row-resize;
  color: var(--color-icon);
  opacity: 0;
  transition: opacity 0.2s;
  z-index: 1;

  &:hover {
    opacity: 1;
  }

  .anticon {
    transform: rotate(90deg);
    font-size: 14px;
  }
`

const Container = styled.div`
  display: flex;
  flex-direction: column;
  position: relative;
  z-index: 2;
`

const InputBarContainer = styled.div`
  border: 0.5px solid var(--color-border);
  transition: all 0.2s ease;
  position: relative;
  margin: 14px 20px;
  margin-top: 0;
  border-radius: 15px;
  padding-top: 6px; // 为拖动手柄留出空间
  background-color: var(--color-background-opacity);
`

const TextareaStyle: CSSProperties = {
  paddingLeft: 0,
  padding: '6px 15px 8px' // 减小顶部padding
}

const Textarea = styled(TextArea)`
  padding: 0;
  border-radius: 0;
  display: flex;
  flex: 1;
  font-family: Ubuntu;
  resize: none !important;
  overflow: auto;
  width: 100%;
  box-sizing: border-box;
  &.ant-input {
    line-height: 1.4;
  }
`

const Toolbar = styled.div`
  display: flex;
  flex-direction: row;
  justify-content: space-between;
  padding: 0 8px;
  padding-bottom: 0;
  margin-bottom: 4px;
  height: 36px;
`

const ToolbarMenu = styled.div`
  display: flex;
  flex-direction: row;
  align-items: center;
  gap: 6px;
`

const ToolbarButton = styled(Button)`
  width: 30px;
  height: 30px;
  font-size: 16px;
  border-radius: 50%;
  transition: all 0.3s ease;
  color: var(--color-icon);
  display: flex;
  flex-direction: row;
  justify-content: center;
  align-items: center;
  padding: 0;
  &.anticon,
  &.iconfont {
    transition: all 0.3s ease;
    color: var(--color-icon);
  }
  .icon-a-addchat {
    font-size: 18px;
    margin-bottom: -2px;
  }
  &:hover {
    background-color: var(--color-background-soft);
    .anticon,
    .iconfont {
      color: var(--color-text-1);
    }
  }
  &.active {
    background-color: var(--color-primary) !important;
    .anticon,
    .iconfont {
      color: var(--color-white-soft);
    }
    &:hover {
      background-color: var(--color-primary);
    }
  }
`

export default Inputbar
