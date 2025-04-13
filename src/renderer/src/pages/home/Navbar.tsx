import { BookOutlined, FormOutlined, SearchOutlined } from '@ant-design/icons'
import { Navbar, NavbarLeft, NavbarRight } from '@renderer/components/app/Navbar'
import { HStack } from '@renderer/components/Layout'
import MinAppsPopover from '@renderer/components/Popups/MinAppsPopover'
import SearchPopup from '@renderer/components/Popups/SearchPopup'
import ShortMemoryPopup from '@renderer/components/Popups/ShortMemoryPopup'
import { isMac } from '@renderer/config/constant'
import { useAssistant } from '@renderer/hooks/useAssistant'
import { modelGenerating } from '@renderer/hooks/useRuntime'
import { useSettings } from '@renderer/hooks/useSettings'
import { useShortcut } from '@renderer/hooks/useShortcuts'
import { useShowAssistants, useShowTopics } from '@renderer/hooks/useStore'
import { EVENT_NAMES, EventEmitter } from '@renderer/services/EventService'
import { analyzeAndAddShortMemories } from '@renderer/services/MemoryService'
import { useAppDispatch } from '@renderer/store'
import { setNarrowMode } from '@renderer/store/settings'
import { Assistant, Topic } from '@renderer/types'
import { Button, Tooltip } from 'antd'
import { t } from 'i18next'
import { FC } from 'react'
import styled from 'styled-components'

import SelectModelButton from './components/SelectModelButton'
import UpdateAppButton from './components/UpdateAppButton'

interface Props {
  activeAssistant: Assistant
  activeTopic: Topic
  setActiveTopic: (topic: Topic) => void
}

const HeaderNavbar: FC<Props> = ({ activeAssistant, activeTopic }) => {
  const { assistant } = useAssistant(activeAssistant.id)
  const { showAssistants, toggleShowAssistants } = useShowAssistants()
  const { topicPosition, sidebarIcons, narrowMode } = useSettings()
  const { showTopics, toggleShowTopics } = useShowTopics()
  const dispatch = useAppDispatch()

  useShortcut('toggle_show_assistants', () => {
    toggleShowAssistants()
  })

  useShortcut('toggle_show_topics', () => {
    if (topicPosition === 'right') {
      toggleShowTopics()
    } else {
      EventEmitter.emit(EVENT_NAMES.SHOW_TOPIC_SIDEBAR)
    }
  })

  useShortcut('search_message', () => {
    SearchPopup.show()
  })

  const handleNarrowModeToggle = async () => {
    await modelGenerating()
    dispatch(setNarrowMode(!narrowMode))
  }

  const handleShowShortMemory = () => {
    if (activeTopic && activeTopic.id) {
      ShortMemoryPopup.show({ topicId: activeTopic.id })
    }
  }

  const handleAnalyzeShortMemory = async () => {
    if (activeTopic && activeTopic.id) {
      try {
        const result = await analyzeAndAddShortMemories(activeTopic.id)
        if (result) {
          window.message.success(t('settings.memory.shortMemoryAnalysisSuccess') || '分析成功')
        } else {
          window.message.info(t('settings.memory.shortMemoryAnalysisNoNew') || '无新信息')
        }
      } catch (error) {
        console.error('Failed to analyze conversation for short memory:', error)
        window.message.error(t('settings.memory.shortMemoryAnalysisError') || '分析失败')
      }
    }
  }

  return (
    <Navbar className="home-navbar">
      {showAssistants && (
        <NavbarLeft style={{ justifyContent: 'space-between', borderRight: 'none', padding: 0 }}>
          <Tooltip title={t('navbar.hide_sidebar')} mouseEnterDelay={0.8}>
            <NavbarIcon onClick={toggleShowAssistants} style={{ marginLeft: isMac ? 16 : 0 }}>
              <i className="iconfont icon-hide-sidebar" />
            </NavbarIcon>
          </Tooltip>
          <Tooltip title={t('settings.shortcuts.new_topic')} mouseEnterDelay={0.8}>
            <NavbarIcon onClick={() => EventEmitter.emit(EVENT_NAMES.ADD_NEW_TOPIC)}>
              <FormOutlined />
            </NavbarIcon>
          </Tooltip>
        </NavbarLeft>
      )}
      <NavbarRight style={{ justifyContent: 'space-between', flex: 1 }} className="home-navbar-right">
        <HStack alignItems="center">
          {!showAssistants && (
            <Tooltip title={t('navbar.show_sidebar')} mouseEnterDelay={0.8}>
              <NavbarIcon
                onClick={() => toggleShowAssistants()}
                style={{ marginRight: 8, marginLeft: isMac ? 4 : -12 }}>
                <i className="iconfont icon-show-sidebar" />
              </NavbarIcon>
            </Tooltip>
          )}
          <SelectModelButton assistant={assistant} />
        </HStack>
        <HStack alignItems="center" gap={8}>
          <UpdateAppButton />
          <Tooltip title={t('settings.memory.shortMemory')} mouseEnterDelay={0.8}>
            <NarrowIcon onClick={handleShowShortMemory}>
              <BookOutlined />
            </NarrowIcon>
          </Tooltip>
          <AnalyzeButton onClick={handleAnalyzeShortMemory}>
            {t('settings.memory.analyzeConversation') || '分析对话'}
          </AnalyzeButton>
          <Tooltip title={t('chat.assistant.search.placeholder')} mouseEnterDelay={0.8}>
            <NarrowIcon onClick={() => SearchPopup.show()}>
              <SearchOutlined />
            </NarrowIcon>
          </Tooltip>
          <Tooltip title={t('navbar.expand')} mouseEnterDelay={0.8}>
            <NarrowIcon onClick={handleNarrowModeToggle}>
              <i className="iconfont icon-icon-adaptive-width"></i>
            </NarrowIcon>
          </Tooltip>
          {sidebarIcons.visible.includes('minapp') && (
            <MinAppsPopover>
              <Tooltip title={t('minapp.title')} mouseEnterDelay={0.8}>
                <NarrowIcon>
                  <i className="iconfont icon-appstore" />
                </NarrowIcon>
              </Tooltip>
            </MinAppsPopover>
          )}
          {topicPosition === 'right' && (
            <NarrowIcon onClick={toggleShowTopics}>
              <i className={`iconfont icon-${showTopics ? 'show' : 'hide'}-sidebar`} />
            </NarrowIcon>
          )}
        </HStack>
      </NavbarRight>
    </Navbar>
  )
}

export const NavbarIcon = styled.div`
  -webkit-app-region: none;
  border-radius: 8px;
  height: 30px;
  padding: 0 7px;
  display: flex;
  flex-direction: row;
  justify-content: center;
  align-items: center;
  transition: all 0.2s ease-in-out;
  cursor: pointer;
  .iconfont {
    font-size: 18px;
    color: var(--color-icon);
    &.icon-a-addchat {
      font-size: 20px;
    }
    &.icon-a-darkmode {
      font-size: 20px;
    }
    &.icon-appstore {
      font-size: 20px;
    }
  }
  .anticon {
    color: var(--color-icon);
    font-size: 16px;
  }
  &:hover {
    background-color: var(--color-background-mute);
    color: var(--color-icon-white);
  }
`

const NarrowIcon = styled(NavbarIcon)`
  @media (max-width: 1000px) {
    display: none;
  }
`

const AnalyzeButton = styled(Button)`
  font-size: 12px;
  height: 28px;
  padding: 0 10px;
  border-radius: 4px;
  margin-right: 8px;
  -webkit-app-region: none;

  @media (max-width: 1000px) {
    display: none;
  }
`

export default HeaderNavbar
