import store from '@renderer/store';
import { fetchChatCompletion } from '@renderer/services/ApiService';
import { getAssistantMessage, getUserMessage } from '@renderer/services/MessagesService';
import { getDefaultAssistant } from '@renderer/services/AssistantService';
import TTSService from '@renderer/services/TTSService';
import ASRService from '@renderer/services/ASRService';
// 导入类型
import type { Message } from '@renderer/types';

interface VoiceCallCallbacks {
  onTranscript: (text: string) => void;
  onResponse: (text: string) => void;
  onListeningStateChange: (isListening: boolean) => void;
  onSpeakingStateChange: (isSpeaking: boolean) => void;
}

// 为TypeScript添加SpeechRecognition类型
declare global {
  interface Window {
    SpeechRecognition: any;
    webkitSpeechRecognition: any;
  }
}

class VoiceCallServiceClass {
  private recognition: any = null;
  private isCallActive = false;
  private isRecording = false; // 新增录音状态
  private isMuted = false;
  private isPaused = false;
  private callbacks: VoiceCallCallbacks | null = null;
  private _currentTranscript = '';  // 使用下划线前缀避免未使用警告
  private _accumulatedTranscript = '';  // 累积的语音识别结果
  private conversationHistory: { role: string; content: string }[] = [];
  private isProcessingResponse = false;
  private ttsService = TTSService;
  private recordingTimeout: NodeJS.Timeout | null = null; // 录音超时定时器

  async initialize() {
    // 检查麦克风权限
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      stream.getTracks().forEach(track => track.stop());
    } catch (error) {
      console.error('Microphone permission denied:', error);
      throw new Error('Microphone permission denied');
    }

    // 获取当前ASR服务类型
    const { asrServiceType } = store.getState().settings;

    // 如果使用浏览器ASR，检查浏览器支持
    if (asrServiceType === 'browser') {
      if (!('webkitSpeechRecognition' in window) && !('SpeechRecognition' in window)) {
        throw new Error('Speech recognition not supported in this browser');
      }

      // 初始化浏览器语音识别
      const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
      this.recognition = new SpeechRecognition();
      this.recognition.continuous = true;
      this.recognition.interimResults = true;
      this.recognition.lang = navigator.language || 'zh-CN';
    } else if (asrServiceType === 'local') {
      // 如果使用本地服务器ASR，检查连接
      try {
        // 尝试连接本地ASR服务器
        const connected = await ASRService.connectToWebSocketServer();
        if (!connected) {
          throw new Error('无法连接到语音识别服务');
        }
      } catch (error) {
        console.error('Failed to connect to ASR server:', error);
        throw new Error('Failed to connect to ASR server');
      }
    }

    return true;
  }

  async startCall(callbacks: VoiceCallCallbacks) {
    this.callbacks = callbacks;
    this.isCallActive = true;
    this.conversationHistory = [];

    // 获取当前ASR服务类型
    const { asrServiceType } = store.getState().settings;

    // 根据不同的ASR服务类型进行初始化
    if (asrServiceType === 'browser') {
      if (!this.recognition) {
        throw new Error('Browser speech recognition not initialized');
      }

      // 设置浏览器语音识别事件处理
      this.recognition.onresult = (event: any) => {
        let interimTranscript = '';
        let finalTranscript = '';

        for (let i = event.resultIndex; i < event.results.length; ++i) {
          if (event.results[i].isFinal) {
            finalTranscript += event.results[i][0].transcript;
          } else {
            interimTranscript += event.results[i][0].transcript;
          }
        }

        if (interimTranscript) {
          // 更新当前的临时识别结果
          this._currentTranscript = interimTranscript;
          // 显示累积结果 + 当前临时结果
          this.callbacks?.onTranscript(this._accumulatedTranscript + ' ' + interimTranscript);
        }

        if (finalTranscript) {
          // 将最终结果累积到总结果中
          if (this._accumulatedTranscript) {
            // 如果已经有累积的文本，添加空格再追加
            this._accumulatedTranscript += ' ' + finalTranscript;
          } else {
            // 如果是第一段文本，直接设置
            this._accumulatedTranscript = finalTranscript;
          }

          // 更新当前的识别结果
          this._currentTranscript = '';
          // 显示累积的完整结果
          this.callbacks?.onTranscript(this._accumulatedTranscript);

          // 在录音过程中只更新transcript，不触发handleUserSpeech
          // 松开按钮后才会处理完整的录音内容
        }
      };

      this.recognition.onstart = () => {
        this.isRecording = true;
        this.callbacks?.onListeningStateChange(true);
      };

      this.recognition.onend = () => {
        this.isRecording = false;
        this.callbacks?.onListeningStateChange(false);
      };

      this.recognition.onerror = (event: any) => {
        console.error('Speech recognition error', event.error);
        this.isRecording = false;
        this.callbacks?.onListeningStateChange(false);
      };
    }

    // 播放欢迎语音
    const welcomeMessage = '您好，我是您的AI助手，请长按说话按钮进行对话。';
    this.callbacks?.onResponse(welcomeMessage);

    // 监听TTS状态
    const ttsStateHandler = (isPlaying: boolean) => {
      this.callbacks?.onSpeakingStateChange(isPlaying);
    };

    // 监听TTS播放状态
    window.addEventListener('tts-state-change', (event: any) => {
      ttsStateHandler(event.detail.isPlaying);
    });

    // 播放欢迎语音，并手动设置初始状态
    this.callbacks?.onSpeakingStateChange(true);
    this.ttsService.speak(welcomeMessage);

    // 确保欢迎语音结束后状态正确
    setTimeout(() => {
      if (this.ttsService && !this.ttsService.isCurrentlyPlaying()) {
        this.callbacks?.onSpeakingStateChange(false);
      }
    }, 5000); // 5秒后检查TTS状态

    return true;
  }

  /**
   * 开始录音
   * @returns Promise<boolean> 是否成功开始录音
   */
  async startRecording(): Promise<boolean> {
    if (!this.isCallActive || this.isPaused || this.isProcessingResponse || this.isRecording) {
      return false;
    }

    // 重置累积的文本
    this._accumulatedTranscript = '';

    // 获取当前ASR服务类型
    const { asrServiceType } = store.getState().settings;

    try {
      if (asrServiceType === 'browser') {
        // 浏览器ASR
        if (!this.recognition) {
          throw new Error('Browser speech recognition not initialized');
        }

        this.recognition.start();
        this.isRecording = true;

      } else if (asrServiceType === 'local') {
        // 本地服务器ASR
        await ASRService.startRecording((text, isFinal) => {
          if (text) {
            if (isFinal) {
              // 如果是最终结果，累积到总结果中
              if (this._accumulatedTranscript) {
                // 如果已经有累积的文本，添加空格再追加
                this._accumulatedTranscript += ' ' + text;
              } else {
                // 如果是第一段文本，直接设置
                this._accumulatedTranscript = text;
              }

              // 更新当前的识别结果
              this._currentTranscript = '';
              // 显示累积的完整结果
              this.callbacks?.onTranscript(this._accumulatedTranscript);
            } else {
              // 如果是临时结果，更新当前的识别结果
              this._currentTranscript = text;
              // 显示累积结果 + 当前临时结果
              this.callbacks?.onTranscript(this._accumulatedTranscript + ' ' + text);
            }

            // 在录音过程中只更新transcript，不触发handleUserSpeech
            // 松开按钮后才会处理完整的录音内容
          }
        });

        this.isRecording = true;
        this.callbacks?.onListeningStateChange(true);

      } else if (asrServiceType === 'openai') {
        // OpenAI ASR
        await ASRService.startRecording();
        this.isRecording = true;
        this.callbacks?.onListeningStateChange(true);
      }

      // 设置最长录音时间，防止用户忘记松开
      this.recordingTimeout = setTimeout(() => {
        if (this.isRecording) {
          this.stopRecording();
        }
      }, 60000); // 60秒最长录音时间

      return true;
    } catch (error) {
      console.error('Failed to start recording:', error);
      this.isRecording = false;
      this.callbacks?.onListeningStateChange(false);
      return false;
    }
  }

  /**
   * 停止录音并处理结果，将录音内容发送给AI
   * @returns Promise<boolean> 是否成功停止录音
   */
  async stopRecording(): Promise<boolean> {
    if (!this.isCallActive || !this.isRecording) {
      return false;
    }

    // 清除录音超时定时器
    if (this.recordingTimeout) {
      clearTimeout(this.recordingTimeout);
      this.recordingTimeout = null;
    }

    // 获取当前ASR服务类型
    const { asrServiceType } = store.getState().settings;

    try {
      // 存储当前的语音识别结果，用于松开按钮后发送给AI
      const currentTranscript = this._currentTranscript;
      // 存储累积的语音识别结果
      const accumulatedTranscript = this._accumulatedTranscript;

      if (asrServiceType === 'browser') {
        // 浏览器ASR
        if (!this.recognition) {
          throw new Error('Browser speech recognition not initialized');
        }

        this.recognition.stop();
        // onend事件将设置isRecording = false
        this.isRecording = false;
        this.callbacks?.onListeningStateChange(false);

        // 优先使用累积的文本，如果有的话
        if (accumulatedTranscript) {
          console.log('发送累积的语音识别结果给AI:', accumulatedTranscript);
          this.handleUserSpeech(accumulatedTranscript);
        } else if (currentTranscript) {
          // 如果没有累积结果，使用当前结果
          console.log('没有累积结果，使用当前结果:', currentTranscript);
          this.handleUserSpeech(currentTranscript);
        }

      } else if (asrServiceType === 'local') {
        // 本地服务器ASR
        // 创建一个承诺，等待最终结果
        const finalResultPromise = new Promise<string>((resolve) => {
          // 设置一个超时器，确保不会无限等待
          const timeoutId = setTimeout(() => {
            console.log('等待最终结果超时，使用当前结果');
            resolve(this._currentTranscript);
          }, 1500); // 1.5秒超时

          // 设置回调函数来接收最终结果
          const resultCallback = (text: string) => {
            // 如果是空字符串，表示只是重置状态，不处理
            if (text === '') return;

            if (text) {
              clearTimeout(timeoutId);
              console.log('收到最终语音识别结果:', text);
              this._currentTranscript = text;
              this.callbacks?.onTranscript(text);
              resolve(text);
            }
          };

          // 停止录音，但不取消，以获取最终结果
          ASRService.stopRecording(resultCallback);
          this.isRecording = false;
          this.callbacks?.onListeningStateChange(false);

          // 添加额外的安全措施，在停止后立即发送重置命令
          setTimeout(() => {
            // 发送重置命令，确保浏览器不会继续发送结果
            ASRService.cancelRecording();
          }, 2000); // 2秒后强制取消，作为安全措施
        });

        // 等待最终结果
        const finalText = await finalResultPromise;

        // 优先使用累积的文本，如果有的话
        if (accumulatedTranscript) {
          console.log('发送累积的语音识别结果给AI:', accumulatedTranscript);
          this.handleUserSpeech(accumulatedTranscript);
        } else if (finalText) {
          // 如果没有累积结果，使用最终结果
          console.log('发送最终语音识别结果给AI:', finalText);
          this.handleUserSpeech(finalText);
        } else if (currentTranscript) {
          // 如果没有最终结果，使用当前结果
          console.log('没有最终结果，使用当前结果:', currentTranscript);
          this.handleUserSpeech(currentTranscript);
        }

      } else if (asrServiceType === 'openai') {
        // OpenAI ASR
        await ASRService.stopRecording((text) => {
          // 更新最终的语音识别结果
          if (text) {
            this._currentTranscript = text;
            this.callbacks?.onTranscript(text);
          }
        });

        this.isRecording = false;
        this.callbacks?.onListeningStateChange(false);

        // 使用最新的语音识别结果
        const finalTranscript = this._currentTranscript;
        if (finalTranscript) {
          this.handleUserSpeech(finalTranscript);
        }
      }

      return true;
    } catch (error) {
      console.error('Failed to stop recording:', error);
      this.isRecording = false;
      this.callbacks?.onListeningStateChange(false);
      return false;
    }
  }

  async handleUserSpeech(text: string) {
    if (!this.isCallActive || this.isProcessingResponse || this.isPaused) return;

    // 暂停语音识别，避免在AI回复时继续识别
    const { asrServiceType } = store.getState().settings;
    if (asrServiceType === 'browser') {
      this.recognition?.stop();
    } else if (asrServiceType === 'local' || asrServiceType === 'openai') {
      ASRService.cancelRecording();
    }

    this.isProcessingResponse = true;

    try {
      // 获取当前助手
      const assistant = getDefaultAssistant();

      // 创建一个简单的Topic对象
      const topic = {
        id: 'voice-call',
        assistantId: assistant.id,
        name: 'Voice Call',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        messages: []
      };

      // 创建用户消息
      const userMessage = getUserMessage({
        assistant,
        topic,
        type: 'text',
        content: text
      });

      // 创建助手消息
      const assistantMessage = getAssistantMessage({
        assistant,
        topic
      });

      // 更新对话历史
      this.conversationHistory.push({ role: 'user', content: text });

      // 构建消息列表
      // 将历史消息转换为正确的Message对象
      const historyMessages = this.conversationHistory.map(msg => {
        if (msg.role === 'user') {
          return getUserMessage({
            assistant,
            topic,
            type: 'text',
            content: msg.content
          });
        } else {
          const assistantMsg = getAssistantMessage({
            assistant,
            topic
          });
          return { ...assistantMsg, content: msg.content, status: 'success' };
        }
      });

      // 修改用户消息，添加语音通话提示
      const voiceCallPrompt = `当前是语音通话模式。请注意：
1. 简洁直接地回答问题，避免冗长的引导和总结。
2. 避免使用复杂的格式化内容，如表格、代码块、Markdown等。
3. 使用自然、口语化的表达方式，就像与人对话一样。
4. 如果需要列出要点，使用简单的数字或文字标记，而不是复杂的格式。
5. 回答应该简短有力，便于用户通过语音理解。
6. 避免使用特殊符号、表情符号、标点符号等，因为这些在语音播放时会影响理解。
7. 使用完整的句子而非简单的关键词列表。
8. 尽量使用常见词汇，避免生僻或专业术语，除非用户特别询问。`;

      // 创建系统指令消息
      const systemMessage = getUserMessage({
        assistant,
        topic,
        type: 'text',
        content: voiceCallPrompt
      });

      // 修改用户消息的内容
      userMessage.content = text;

      // 构建最终消息列表
      // 使用类型断言解决类型问题
      const messages = [systemMessage, ...historyMessages, userMessage] as Message[];

      // 流式响应处理
      let fullResponse = '';

      try {
        // 调用真实的LLM API
        await fetchChatCompletion({
          message: assistantMessage,
          messages,
          assistant,
          onResponse: async (msg) => {
            if (msg.content && msg.content !== fullResponse) {
              fullResponse = msg.content;

              // 更新UI
              this.callbacks?.onResponse(fullResponse);

              // 如果TTS正在播放，停止它
              if (this.ttsService.isCurrentlyPlaying()) {
                this.ttsService.stop();
              }
            }
          }
        });

        // 播放完整响应
        if (!this.isMuted && this.isCallActive) {
          // 手动设置语音状态
          this.callbacks?.onSpeakingStateChange(true);
          this.ttsService.speak(fullResponse);

          // 确保语音结束后状态正确
          setTimeout(() => {
            if (this.ttsService && !this.ttsService.isCurrentlyPlaying()) {
              this.callbacks?.onSpeakingStateChange(false);
            }
          }, 1000); // 1秒后检查TTS状态
        }

        // 更新对话历史
        this.conversationHistory.push({ role: 'assistant', content: fullResponse });

      } catch (innerError) {
        console.error('Error generating response:', innerError);
        // 如果出错，使用一个简单的回复
        fullResponse = `抱歉，处理您的请求时出错了。`;
        this.callbacks?.onResponse(fullResponse);

        if (!this.isMuted && this.isCallActive) {
          // 手动设置语音状态
          this.callbacks?.onSpeakingStateChange(true);
          this.ttsService.speak(fullResponse);

          // 确保语音结束后状态正确
          setTimeout(() => {
            if (this.ttsService && !this.ttsService.isCurrentlyPlaying()) {
              this.callbacks?.onSpeakingStateChange(false);
            }
          }, 1000); // 1秒后检查TTS状态
        }
      }

    } catch (error) {
      console.error('Error processing voice response:', error);
    } finally {
      this.isProcessingResponse = false;

      // 不自动恢复语音识别，等待用户长按按钮
      // 长按说话模式下，我们不需要自动恢复语音识别
    }
  }

  /**
   * 取消录音，不发送给AI
   * @returns Promise<boolean> 是否成功取消录音
   */
  async cancelRecording(): Promise<boolean> {
    if (!this.isCallActive || !this.isRecording) {
      return false;
    }

    // 清除录音超时定时器
    if (this.recordingTimeout) {
      clearTimeout(this.recordingTimeout);
      this.recordingTimeout = null;
    }

    // 获取当前ASR服务类型
    const { asrServiceType } = store.getState().settings;

    try {
      if (asrServiceType === 'browser') {
        // 浏览器ASR
        if (!this.recognition) {
          throw new Error('Browser speech recognition not initialized');
        }

        this.recognition.stop();
        this.isRecording = false;
        this.callbacks?.onListeningStateChange(false);

      } else if (asrServiceType === 'local') {
        // 本地服务器ASR
        ASRService.cancelRecording();
        this.isRecording = false;
        this.callbacks?.onListeningStateChange(false);

      } else if (asrServiceType === 'openai') {
        // OpenAI ASR
        ASRService.cancelRecording();
        this.isRecording = false;
        this.callbacks?.onListeningStateChange(false);
      }

      // 清除当前识别结果
      this._currentTranscript = '';
      this.callbacks?.onTranscript('');

      return true;
    } catch (error) {
      console.error('Failed to cancel recording:', error);
      this.isRecording = false;
      this.callbacks?.onListeningStateChange(false);
      return false;
    }
  }

  setMuted(muted: boolean) {
    this.isMuted = muted;

    // 如果设置为静音，停止当前TTS播放
    if (muted && this.ttsService.isCurrentlyPlaying()) {
      this.ttsService.stop();
    }
  }

  setPaused(paused: boolean) {
    this.isPaused = paused;

    // 获取当前ASR服务类型
    const { asrServiceType } = store.getState().settings;

    if (paused) {
      // 暂停语音识别
      if (asrServiceType === 'browser') {
        this.recognition?.stop();
      } else if (asrServiceType === 'local' || asrServiceType === 'openai') {
        ASRService.cancelRecording();
      }

      // 暂停TTS
      if (this.ttsService.isCurrentlyPlaying()) {
        this.ttsService.stop();
      }
    }
    // 不自动恢复语音识别，等待用户长按按钮
  }

  endCall() {
    this.isCallActive = false;

    // 获取当前ASR服务类型
    const { asrServiceType } = store.getState().settings;

    // 停止语音识别
    if (asrServiceType === 'browser') {
      this.recognition?.stop();
    } else if (asrServiceType === 'local' || asrServiceType === 'openai') {
      ASRService.cancelRecording();
    }

    // 停止TTS
    if (this.ttsService.isCurrentlyPlaying()) {
      this.ttsService.stop();
    }

    this.callbacks = null;
  }
}

export const VoiceCallService = new VoiceCallServiceClass();
