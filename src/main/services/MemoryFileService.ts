import { promises as fs } from 'fs'
import path from 'path'
import { getConfigDir } from '../utils/file'
import { IpcChannel } from '@shared/IpcChannel'
import { ipcMain } from 'electron'
import log from 'electron-log'

// 定义记忆文件路径
const memoryDataPath = path.join(getConfigDir(), 'memory-data.json')

export class MemoryFileService {
  constructor() {
    this.registerIpcHandlers()
  }

  private registerIpcHandlers() {
    // 读取记忆数据
    ipcMain.handle(IpcChannel.Memory_LoadData, async () => {
      try {
        // 确保配置目录存在
        const configDir = path.dirname(memoryDataPath)
        try {
          await fs.mkdir(configDir, { recursive: true })
        } catch (mkdirError) {
          log.warn('Failed to create config directory, it may already exist:', mkdirError)
        }

        // 检查文件是否存在
        try {
          await fs.access(memoryDataPath)
        } catch (accessError) {
          // 文件不存在，创建默认文件
          log.info('Memory data file does not exist, creating default file')
          const defaultData = {
            memoryLists: [{
              id: 'default',
              name: '默认列表',
              isActive: true
            }],
            memories: [],
            shortMemories: [],
            analyzeModel: 'gpt-3.5-turbo',
            shortMemoryAnalyzeModel: 'gpt-3.5-turbo',
            vectorizeModel: 'gpt-3.5-turbo'
          }
          await fs.writeFile(memoryDataPath, JSON.stringify(defaultData, null, 2))
          return defaultData
        }

        // 读取文件
        const data = await fs.readFile(memoryDataPath, 'utf-8')
        const parsedData = JSON.parse(data)
        log.info('Memory data loaded successfully')
        return parsedData
      } catch (error) {
        log.error('Failed to load memory data:', error)
        return null
      }
    })

    // 保存记忆数据
    ipcMain.handle(IpcChannel.Memory_SaveData, async (_, data) => {
      try {
        // 确保配置目录存在
        const configDir = path.dirname(memoryDataPath)
        try {
          await fs.mkdir(configDir, { recursive: true })
        } catch (mkdirError) {
          log.warn('Failed to create config directory, it may already exist:', mkdirError)
        }

        // 尝试读取现有数据并合并
        let existingData = {}
        try {
          await fs.access(memoryDataPath)
          const fileContent = await fs.readFile(memoryDataPath, 'utf-8')
          existingData = JSON.parse(fileContent)
          log.info('Existing memory data loaded for merging')
        } catch (readError) {
          log.warn('No existing memory data found or failed to read:', readError)
          // 如果文件不存在或读取失败，使用空对象
        }

        // 合并数据，注意数组的处理
        const mergedData = { ...existingData }

        // 处理每个属性
        Object.entries(data).forEach(([key, value]) => {
          // 如果是数组属性，需要特殊处理
          if (Array.isArray(value) && Array.isArray(mergedData[key])) {
            // 对于 memories 和 shortMemories，需要合并而不是覆盖
            if (key === 'memories' || key === 'shortMemories') {
              // 创建一个集合来跟踪已存在的记忆ID
              const existingIds = new Set(mergedData[key].map(item => item.id))

              // 将新记忆添加到现有记忆中，避免重复
              value.forEach(item => {
                if (item.id && !existingIds.has(item.id)) {
                  mergedData[key].push(item)
                  existingIds.add(item.id)
                }
              })
            } else {
              // 其他数组属性，使用新值
              mergedData[key] = value
            }
          } else {
            // 非数组属性，直接使用新值
            mergedData[key] = value
          }
        })

        // 保存合并后的数据
        await fs.writeFile(memoryDataPath, JSON.stringify(mergedData, null, 2))
        log.info('Memory data saved successfully')
        return true
      } catch (error) {
        log.error('Failed to save memory data:', error)
        return false
      }
    })
  }
}

// 创建单例实例
export const memoryFileService = new MemoryFileService()
