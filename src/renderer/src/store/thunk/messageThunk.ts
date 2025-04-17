import db from '@renderer/databases'
import { fetchChatCompletion } from '@renderer/services/ApiService'
import { createStreamProcessor, type StreamProcessorCallbacks } from '@renderer/services/StreamProcessingService'
import store from '@renderer/store'
import type { Assistant, MCPToolResponse, Topic } from '@renderer/types'
import type { Message, MessageBlock } from '@renderer/types/newMessageTypes'
import { MessageBlockStatus, MessageBlockType } from '@renderer/types/newMessageTypes'
import {
  createAssistantMessage,
  createErrorBlock,
  createImageBlock,
  createMainTextBlock,
  createToolBlock
} from '@renderer/utils/messageUtils/create'
import { getTopicQueue } from '@renderer/utils/queue'
import { throttle } from 'lodash'

import type { AppDispatch, RootState } from '../index'
import { updateOneBlock, upsertManyBlocks, upsertOneBlock } from '../messageBlock'
import { newMessagesActions } from '../newMessage'

const saveMessageAndBlocksToDB = async (message: Message, blocks: MessageBlock[]) => {
  try {
    if (blocks.length > 0) {
      await db.message_blocks.bulkPut(blocks)
    }
    const topic = await db.topics.get(message.topicId)
    if (topic) {
      const messageIndex = topic.messages.findIndex((m) => m.id === message.id)
      const updatedMessages = [...topic.messages]

      if (messageIndex !== -1) {
        updatedMessages[messageIndex] = message
      } else {
        updatedMessages.push(message)
      }
      await db.topics.update(message.topicId, { messages: updatedMessages })
    } else {
      console.error(`[saveMessageAndBlocksToDB] Topic ${message.topicId} not found.`)
    }
  } catch (error) {
    console.error(`[saveMessageAndBlocksToDB] Failed to save message ${message.id}:`, error)
  }
}

const updateExistingMessageAndBlocksInDB = async (
  updatedMessage: Partial<Message> & Pick<Message, 'id' | 'topicId'>,
  updatedBlocks: MessageBlock[]
) => {
  try {
    // Always update blocks if provided
    if (updatedBlocks.length > 0) {
      await db.message_blocks.bulkPut(updatedBlocks)
    }

    // Check if there are message properties to update beyond id and topicId
    const messageKeysToUpdate = Object.keys(updatedMessage).filter((key) => key !== 'id' && key !== 'topicId')

    // Only proceed with topic update if there are actual message changes
    if (messageKeysToUpdate.length > 0) {
      const topic = await db.topics.get(updatedMessage.topicId)
      if (topic) {
        const messageIndex = topic.messages.findIndex((m) => m.id === updatedMessage.id)
        if (messageIndex !== -1) {
          const newMessages = [...topic.messages]
          // Apply the updates passed in updatedMessage
          Object.assign(newMessages[messageIndex], updatedMessage)
          await db.topics.update(updatedMessage.topicId, { messages: newMessages })
        } else {
          console.error(`[updateExistingMsg] Message ${updatedMessage.id} not found in topic ${updatedMessage.topicId}`)
        }
      } else {
        console.error(`[updateExistingMsg] Topic ${updatedMessage.topicId} not found.`)
      }
    }
    // If messageKeysToUpdate.length === 0, we skip topic fetch/update entirely
  } catch (error) {
    console.error(`[updateExistingMsg] Failed to update message ${updatedMessage.id}:`, error)
  }
}
const throttledBlockUpdate = throttle((id, blockUpdate) => {
  store.dispatch(updateOneBlock({ id, changes: blockUpdate }))
}, 150)

// const throttledMessageUpdate = throttle((topicId, messageId, messageUpdates) => {
//   const dispatch = store.dispatch
//   dispatch(newMessagesActions.updateMessage({ topicId, messageId, updates: { blockInstruction: messageUpdates } }))
// }, 150)

const messageAndBlockUpdate = (topicId, messageId, blockUpdate) => {
  const dispatch = store.dispatch
  store.dispatch(
    newMessagesActions.updateMessage({ topicId, messageId, updates: { blockInstruction: { id: blockUpdate.id } } })
  )
  dispatch(upsertOneBlock(blockUpdate))

  dispatch(newMessagesActions.upsertBlockReference({ messageId, blockId: blockUpdate.id, status: blockUpdate.status }))
}

const throttledDbUpdate = throttle(
  async (messageId: string, topicId: string, getState: () => RootState) => {
    const state = getState()
    const message = state.messages.messagesByTopic[topicId]?.find((m) => m.id === messageId)
    if (!message) return
    const blockIds = message.blocks
    const blocks = blockIds.map((id) => state.messageBlocks.entities[id]).filter((b) => !!b)
    await updateExistingMessageAndBlocksInDB({ id: messageId, topicId, status: message.status }, blocks)
  },
  500,
  { leading: false, trailing: true }
)

// Internal function extracted from sendMessage to handle fetching and processing assistant response
const fetchAndProcessAssistantResponseImpl = async (
  dispatch: AppDispatch,
  getState: () => RootState,
  topicId: string,
  assistant: Assistant,
  userMessage: Message,
  _contextMessages: Message[],
  passedTopicId: Topic['id']
) => {
  let assistantMessage: Message | null = null
  try {
    // 创建助手消息
    assistantMessage = createAssistantMessage(assistant.id, passedTopicId, { askId: userMessage.id })
    const assistantMsgId = assistantMessage.id
    // 将助手消息添加到store
    dispatch(newMessagesActions.addMessage({ topicId, message: assistantMessage }))
    // 保存助手消息到DB
    await saveMessageAndBlocksToDB(assistantMessage, [])
    // 设置会话加载状态
    dispatch(newMessagesActions.setTopicLoading({ topicId, loading: true }))

    let accumulatedContent = ''
    // Track the last block added to handle interleaving
    let lastBlockId: string | null = null
    let lastBlockType: MessageBlockType | null = null

    // --- Context Message Filtering --- START
    const allMessagesForTopic = getState().messages.messagesByTopic[topicId] || []
    // Filter messages: include up to the assistant message stub, remove 'ing' statuses
    const assistantMessageIndex = allMessagesForTopic.findIndex((m) => m.id === assistantMsgId)
    const messagesForContext = (
      assistantMessageIndex !== -1 ? allMessagesForTopic.slice(0, assistantMessageIndex) : allMessagesForTopic
    ).filter((m) => !m.status?.includes('ing'))
    // TODO: Apply further filtering based on assistant settings (maxContextMessages, etc.) if needed
    // --- Context Message Filtering --- END

    // const _throttledBlockUpdate = throttledBlockUpdate.bind(null, dispatch)
    // const _messageAndBlockUpdate = messageAndBlockUpdate.bind(null, dispatch)

    const callbacks: StreamProcessorCallbacks = {
      onTextChunk: (text) => {
        accumulatedContent += text
        if (lastBlockType === MessageBlockType.MAIN_TEXT && lastBlockId) {
          throttledBlockUpdate(lastBlockId, {
            content: accumulatedContent
          })
        } else {
          // Create a new main text block
          const newBlock = createMainTextBlock(assistantMsgId, accumulatedContent, {
            status: MessageBlockStatus.STREAMING
          })
          lastBlockId = newBlock.id // Update tracker
          lastBlockType = MessageBlockType.MAIN_TEXT // Update tracker
          messageAndBlockUpdate(topicId, assistantMsgId, newBlock)
        }

        throttledDbUpdate(assistantMsgId, topicId, getState)
      },
      onToolCallComplete: (toolResponse: MCPToolResponse) => {
        const toolBlock = createToolBlock(assistantMsgId, toolResponse.id, {
          toolName: toolResponse.tool.name,
          content: toolResponse.response,
          status: toolResponse.status === 'done' ? MessageBlockStatus.SUCCESS : MessageBlockStatus.ERROR,
          ...(toolResponse.status !== 'done' && {
            error: { message: `Tool status: ${toolResponse.status}`, details: toolResponse.response }
          })
        })
        // Update trackers after adding the tool block
        lastBlockId = toolBlock.id
        lastBlockType = MessageBlockType.TOOL
        // Reset accumulated content for the next potential text chunk
        accumulatedContent = ''

        throttledStateUpdate(dispatch, assistantMsgId, topicId, [toolBlock], { status: 'processing' }, getState)
        throttledDbUpdate(assistantMsgId, topicId, getState)
      },
      onCitationData: (citations) => {
        // TODO: Implement actual citation block creation
        console.warn('onCitationData received, creating placeholder CitationBlock.', citations)
        // Placeholder: Assume citation block is created and update trackers
        // const citationBlock = createCitationBlock(...)
        // lastBlockId = citationBlock.id;
        // lastBlockType = MessageBlockType.CITATION;
        // accumulatedContent = '';
        // throttledStateUpdate(dispatch, assistantMsgId, topicId, [citationBlock], { status: 'processing' }, getState);
        // throttledDbUpdate(assistantMsgId, topicId, getState);
      },
      onImageGenerated: (imageData) => {
        const imageUrl = imageData.images[0]
        const imageBlock = createImageBlock(assistantMsgId, {
          url: imageUrl,
          metadata: { generateImageResponse: imageData },
          status: MessageBlockStatus.SUCCESS
        })
        // Update trackers after adding the image block
        lastBlockId = imageBlock.id
        lastBlockType = MessageBlockType.IMAGE
        accumulatedContent = ''

        throttledStateUpdate(dispatch, assistantMsgId, topicId, [imageBlock], { status: 'processing' }, getState)
        throttledDbUpdate(assistantMsgId, topicId, getState)
      },
      onWebSearchGrounding: (groundingMetadata) => {
        // TODO: Implement actual web search block creation
        console.warn('onWebSearchGrounding received, creating placeholder WebSearchBlock.', groundingMetadata)
        // Placeholder: Assume web search block is created and update trackers
        // const webSearchBlock = createWebSearchBlock(...);
        // lastBlockId = webSearchBlock.id;
        // lastBlockType = MessageBlockType.WEB_SEARCH;
        // accumulatedContent = '';
        // throttledStateUpdate(dispatch, assistantMsgId, topicId, [webSearchBlock], { status: 'processing' }, getState);
        // throttledDbUpdate(assistantMsgId, topicId, getState);
      },
      onError: (error) => {
        console.error('Stream processing error:', error)
        const errorBlock = createErrorBlock(assistantMsgId, {
          message: 'Stream processing error',
          details: error
        })
        dispatch(upsertOneBlock(errorBlock))
        dispatch(
          newMessagesActions.upsertBlockReference({
            messageId: assistantMsgId,
            blockId: errorBlock.id,
            status: errorBlock.status
          })
        )
        // Also update trackers here? Might be less critical as it's an error state.
        lastBlockId = errorBlock.id
        lastBlockType = MessageBlockType.ERROR
        accumulatedContent = ''

        dispatch(
          newMessagesActions.updateMessage({
            topicId,
            messageId: assistantMsgId,
            updates: { status: 'error' }
          })
        )
        throttledDbUpdate(assistantMsgId, topicId, getState)
      },
      onComplete: async (status: 'error' | 'success', finalError?: any) => {
        // if (status === 'error' && finalError) {
        //   console.error('Stream completed with error:', finalError)
        // }
        // const finalState = getState()
        // const finalAssistantMsg = finalState.messages.messagesByTopic[topicId]?.find((m) => m.id === assistantMsgId)
        // // Find the LAST main text block ID if it exists
        // const lastMainTextBlockId = finalAssistantMsg?.blocks
        //   .slice()
        //   .reverse()
        //   .find((blockId) => {
        //     const block = finalState.messageBlocks.entities[blockId]
        //     return block && block.type === MessageBlockType.MAIN_TEXT
        //   })
        // // Set the final status of the last streaming block (if it was main text)
        // if (lastMainTextBlockId) {
        //   const lastMainTextBlock = finalState.messageBlocks.entities[lastMainTextBlockId]
        //   if (lastMainTextBlock && lastMainTextBlock.status === MessageBlockStatus.STREAMING) {
        //     const blockFinalStatus = status === 'error' ? MessageBlockStatus.ERROR : MessageBlockStatus.SUCCESS
        //     dispatch(updateOneBlock({ id: lastMainTextBlockId, changes: { status: blockFinalStatus } }))
        //   }
        // } else if (lastBlockType === MessageBlockType.MAIN_TEXT && lastBlockId) {
        //   // Handle case where the very last block added was main text and might still be streaming
        //   const lastBlock = finalState.messageBlocks.entities[lastBlockId]
        //   if (lastBlock && lastBlock.status === MessageBlockStatus.STREAMING) {
        //     const blockFinalStatus = status === 'error' ? MessageBlockStatus.ERROR : MessageBlockStatus.SUCCESS
        //     dispatch(updateOneBlock({ id: lastBlockId, changes: { status: blockFinalStatus } }))
        //   }
        // }
        // const updates: Partial<Message> = { status }
        // // TODO: Find a way to get the final model used
        // dispatch(
        //   newMessagesActions.updateMessage({
        //     topicId,
        //     messageId: assistantMsgId,
        //     updates
        //   })
        // )
        // throttledDbUpdate(assistantMsgId, topicId, getState) // Ensure final DB update
      }
    }

    const streamProcessorCallbacks = createStreamProcessor(callbacks)

    // Call fetchChatCompletion with filtered context and new callback signature
    await fetchChatCompletion({
      messages: messagesForContext,
      assistant: assistant,
      onChunkReceived: streamProcessorCallbacks
    })
  } catch (error: any) {
    console.error('Error fetching chat completion:', error)
    if (assistantMessage) {
      const errorBlock = createErrorBlock(assistantMessage.id, {
        message: error.message || 'Failed to fetch completion',
        details: error
      })
      dispatch(upsertOneBlock(errorBlock))
      dispatch(
        newMessagesActions.upsertBlockReference({
          messageId: assistantMessage.id,
          blockId: errorBlock.id,
          status: errorBlock.status
        })
      )
      dispatch(
        newMessagesActions.updateMessage({ topicId, messageId: assistantMessage.id, updates: { status: 'error' } })
      )
      throttledDbUpdate(assistantMessage.id, topicId, getState) // Ensure DB is updated on error
    }
  } finally {
    // Check if still loading before setting to false, another message might have started
    const isLoading = getState().messages.loadingByTopic[topicId]
    if (isLoading) {
      dispatch(newMessagesActions.setTopicLoading({ topicId, loading: false }))
    }
  }
}

/**
 * 发送消息并处理助手回复
 * @param userMessage 已创建的用户消息
 * @param userMessageBlocks 用户消息关联的消息块
 * @param assistant 助手对象
 * @param topicId 主题ID
 */
export const sendMessage =
  (userMessage: Message, userMessageBlocks: MessageBlock[], assistant: Assistant, topicId: Topic['id']) =>
  async (dispatch: AppDispatch, getState: () => RootState) => {
    try {
      if (userMessage.blocks.length === 0) {
        console.warn('sendMessage: No blocks in the provided message.')
        return
      }

      // 更新store和DB
      dispatch(newMessagesActions.addMessage({ topicId, message: userMessage }))
      if (userMessageBlocks.length > 0) {
        dispatch(upsertManyBlocks(userMessageBlocks))
      }
      await saveMessageAndBlocksToDB(userMessage, userMessageBlocks)

      // 将获取/处理调用添加到队列
      const queue = getTopicQueue(topicId)
      queue.add(async () => {
        const currentState = getState()
        const allMessages = currentState.messages.messagesByTopic[topicId] || []
        // 传递原始消息列表直到用户消息
        const contextMessages = allMessages.slice(0, allMessages.findIndex((m) => m.id === userMessage.id) + 1)

        await fetchAndProcessAssistantResponseImpl(
          dispatch,
          getState,
          topicId,
          assistant,
          userMessage,
          contextMessages,
          topicId
        )
      })
    } catch (error) {
      console.error('Error in sendMessage thunk:', error)
    }
  }

// Placeholder for the new resendMessage thunk
export const resendMessage =
  (messageToResend: Message, assistant: Assistant, topic: Topic) =>
  async (dispatch: AppDispatch, getState: () => RootState) => {
    console.warn('resendMessage thunk not fully implemented yet.')
    // 初步实现resendMessage逻辑
    try {
      const topicId = topic.id
      // 1. 获取要重发的消息
      const state = getState()

      // 2. 创建新的助手消息作为回复
      const assistantMessage = createAssistantMessage(assistant.id, topicId, { askId: messageToResend.id })

      // 3. 将消息添加到store
      dispatch(newMessagesActions.addMessage({ topicId, message: assistantMessage }))

      // 4. 使用现有的fetchAndProcessAssistantResponseImpl处理助手响应
      // 找到消息上下文
      const allMessages = state.messages.messagesByTopic[topicId] || []
      const messageIndex = allMessages.findIndex((m) => m.id === messageToResend.id)
      const contextMessages =
        messageIndex !== -1 ? allMessages.slice(0, messageIndex + 1) : [...allMessages, messageToResend]

      // 调用处理助手响应的函数
      await fetchAndProcessAssistantResponseImpl(
        dispatch,
        getState,
        topicId,
        assistant,
        messageToResend,
        contextMessages,
        topicId
      )
    } catch (error) {
      console.error('Error in resendMessage thunk:', error)
    }
  }

/**
 * Loads messages and their blocks for a specific topic from the database
 * and updates the Redux store.
 */
export const loadTopicMessagesThunk =
  (topicId: string, forceReload: boolean = false) =>
  async (dispatch: AppDispatch, getState: () => RootState) => {
    const state = getState()
    const topicMessagesExist = state.messages.messagesByTopic[topicId]
    const isLoading = state.messages.loadingByTopic[topicId]

    // Avoid refetching if messages already exist and not forcing reload, or if already loading
    if ((topicMessagesExist && !forceReload) || isLoading) {
      if (topicMessagesExist && isLoading) {
        dispatch(newMessagesActions.setTopicLoading({ topicId, loading: false }))
      }
      return
    }

    dispatch(newMessagesActions.setTopicLoading({ topicId, loading: true }))

    try {
      // Fetch the topic object which contains the messages array
      const topic = await db.topics.get(topicId)
      const messages = topic?.messages || [] // Get messages or default to empty array

      if (messages.length > 0) {
        const messageIds = messages.map((m) => m.id)
        // Fetch all blocks associated with these messages
        const blocks = await db.message_blocks.where('messageId').anyOf(messageIds).toArray()

        // Dispatch actions to update the store
        if (blocks && blocks.length > 0) {
          dispatch(upsertManyBlocks(blocks))
        }
        // Ensure message.blocks is an array of strings before dispatching
        const messagesWithBlockIds = messages.map((m) => ({
          ...m,
          blocks: m.blocks || []
        }))
        dispatch(newMessagesActions.messagesReceived({ topicId, messages: messagesWithBlockIds }))
      } else {
        // No messages found for the topic, dispatch empty array
        dispatch(newMessagesActions.messagesReceived({ topicId, messages: [] }))
      }
    } catch (error: any) {
      // Added type assertion for error
      console.error(`[loadTopicMessagesThunk] Failed to load messages for topic ${topicId}:`, error)
      // Dispatch error state (optional, depends on if you have an error state in newMessage slice)
      // dispatch(newMessagesActions.setTopicError({ topicId, error: error.message }));
      // Ensure loading is set to false even on error
      dispatch(newMessagesActions.setTopicLoading({ topicId, loading: false }))
    }
  }
