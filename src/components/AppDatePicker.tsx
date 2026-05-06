import { useEffect, useRef, useState, type CSSProperties, type MouseEvent, type ReactNode } from 'react'
import { Calendar, ChevronLeft, ChevronRight, Loader2, X } from 'lucide-react'
import './AppDatePicker.scss'

export interface DateRangeValue {
  start: string
  end: string
}

type PickerView = 'day' | 'month' | 'year'
type TriggerVariant = 'field' | 'icon'
type DropdownAlign = 'left' | 'right'

interface QuickOption {
  label: string
  days: number
}

interface CommonDatePickerProps {
  className?: string
  dropdownClassName?: string
  panelClassName?: string
  triggerClassName?: string
  triggerIcon?: ReactNode
  triggerVariant?: TriggerVariant
  align?: DropdownAlign
  inline?: boolean
  placeholder?: string
  confirmLabel?: string
  disabled?: boolean
  loading?: boolean
  showClear?: boolean
  showToday?: boolean
  showQuickOptions?: boolean
  disableFuture?: boolean
  minDate?: Date
  maxDate?: Date
  ariaLabel?: string
}

interface SingleDatePickerProps extends CommonDatePickerProps {
  mode: 'single'
  value: string
  onChange: (date: string) => void
  onCommit?: (date: string) => void
}

interface RangeDatePickerProps extends CommonDatePickerProps {
  mode: 'range'
  range: DateRangeValue
  onChange: (range: DateRangeValue) => void
  onCommit?: (range: DateRangeValue) => void
}

export type AppDatePickerProps = SingleDatePickerProps | RangeDatePickerProps

const MONTH_NAMES = ['一月', '二月', '三月', '四月', '五月', '六月', '七月', '八月', '九月', '十月', '十一月', '十二月']
const SHORT_MONTH_NAMES = ['1月', '2月', '3月', '4月', '5月', '6月', '7月', '8月', '9月', '10月', '11月', '12月']
const WEEKDAY_NAMES = ['日', '一', '二', '三', '四', '五', '六']

const DEFAULT_QUICK_OPTIONS: QuickOption[] = [
  { label: '今天', days: 1 },
  { label: '最近7天', days: 7 },
  { label: '最近30天', days: 30 },
  { label: '最近90天', days: 90 },
  { label: '最近一年', days: 365 },
  { label: '全部时间', days: 0 },
]

const pad2 = (value: number) => String(value).padStart(2, '0')

export function formatDateValue(date: Date) {
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`
}

export function parseDateValue(value: string) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value)
  if (!match) return null

  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])
  const date = new Date(year, month - 1, day)

  if (
    date.getFullYear() !== year ||
    date.getMonth() !== month - 1 ||
    date.getDate() !== day
  ) {
    return null
  }

  return date
}

const addDays = (date: Date, days: number) => {
  const next = new Date(date)
  next.setDate(next.getDate() + days)
  return next
}

const getYearPageStart = (year: number) => Math.floor(year / 12) * 12

const getMonthKey = (year: number, month: number) => `${year}-${pad2(month + 1)}`

const joinClassNames = (...classes: Array<string | false | undefined>) => classes.filter(Boolean).join(' ')

function AppDatePicker(props: AppDatePickerProps) {
  const {
    className,
    dropdownClassName,
    panelClassName,
    triggerClassName,
    triggerIcon,
    triggerVariant = 'field',
    align,
    inline = false,
    disabled = false,
    loading = false,
    showClear = true,
    showToday = true,
    showQuickOptions,
    disableFuture = true,
    minDate,
    maxDate,
    ariaLabel,
  } = props

  const todayValue = formatDateValue(new Date())
  const minDateValue = minDate ? formatDateValue(minDate) : ''
  const providedMaxDateValue = maxDate ? formatDateValue(maxDate) : ''
  const maxDateValue = disableFuture
    ? (providedMaxDateValue && providedMaxDateValue < todayValue ? providedMaxDateValue : todayValue)
    : providedMaxDateValue

  const selectedStart = props.mode === 'single' ? props.value : props.range.start
  const selectedEnd = props.mode === 'single' ? '' : props.range.end
  const placeholder = props.placeholder || (props.mode === 'single' ? '选择日期' : '选择时间范围')
  const confirmLabel = props.confirmLabel || (props.mode === 'single' ? '确定' : '确认')
  const shouldShowQuickOptions = props.mode === 'range' && (showQuickOptions ?? true)
  const dropdownAlign = align || (triggerVariant === 'icon' ? 'right' : 'left')

  const [isOpen, setIsOpen] = useState(false)
  const [viewDate, setViewDate] = useState(() => getInitialViewDate())
  const [pickerView, setPickerView] = useState<PickerView>('day')
  const [yearPageStart, setYearPageStart] = useState(() => getYearPageStart(viewDate.getFullYear()))
  const [draftStart, setDraftStart] = useState(selectedStart)
  const [draftEnd, setDraftEnd] = useState(selectedEnd)
  const [selectingStart, setSelectingStart] = useState(!(props.mode === 'range' && selectedStart && !selectedEnd))
  const [dropdownStyle, setDropdownStyle] = useState<CSSProperties>({})
  const containerRef = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)

  function getInitialViewDate() {
    const selectedDate = parseDateValue(selectedEnd || selectedStart)
    const fallbackDate = maxDateValue ? parseDateValue(maxDateValue) : new Date()
    return clampDate(selectedDate || fallbackDate || new Date())
  }

  function clampDate(date: Date) {
    const value = formatDateValue(date)
    if (maxDateValue && value > maxDateValue) {
      return parseDateValue(maxDateValue) || date
    }
    if (minDateValue && value < minDateValue) {
      return parseDateValue(minDateValue) || date
    }
    return date
  }

  function syncDraftFromProps() {
    const initialDate = getInitialViewDate()
    setDraftStart(selectedStart)
    setDraftEnd(selectedEnd)
    setSelectingStart(!(props.mode === 'range' && selectedStart && !selectedEnd))
    setViewDate(new Date(initialDate.getFullYear(), initialDate.getMonth(), 1))
    setYearPageStart(getYearPageStart(initialDate.getFullYear()))
    setPickerView('day')
  }

  useEffect(() => {
    if (inline) {
      syncDraftFromProps()
    }
  }, [inline, selectedStart, selectedEnd, maxDateValue, minDateValue])

  useEffect(() => {
    if (inline || !isOpen) return

    const handleClickOutside = (event: globalThis.MouseEvent) => {
      if (!containerRef.current?.contains(event.target as Node)) {
        setIsOpen(false)
      }
    }

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setIsOpen(false)
      }
    }

    document.addEventListener('mousedown', handleClickOutside)
    document.addEventListener('keydown', handleKeyDown)
    return () => {
      document.removeEventListener('mousedown', handleClickOutside)
      document.removeEventListener('keydown', handleKeyDown)
    }
  }, [inline, isOpen])

  function positionDropdown() {
    if (!triggerRef.current) return

    const rect = triggerRef.current.getBoundingClientRect()
    const estimatedWidth = props.mode === 'range' && shouldShowQuickOptions ? 444 : 320
    const dropdownWidth = Math.min(estimatedWidth, window.innerWidth - 20)
    const dropdownHeight = props.mode === 'range' ? 408 : 376
    const leftBase = dropdownAlign === 'right' ? rect.right - dropdownWidth : rect.left
    const left = Math.min(Math.max(10, leftBase), Math.max(10, window.innerWidth - dropdownWidth - 10))
    const spaceBelow = window.innerHeight - rect.bottom - 12
    const openUp = spaceBelow < dropdownHeight && rect.top > dropdownHeight

    setDropdownStyle(openUp
      ? { position: 'fixed', left, bottom: window.innerHeight - rect.top + 8, zIndex: 99999 }
      : { position: 'fixed', left, top: rect.bottom + 8, zIndex: 99999 }
    )
  }

  function openPicker() {
    if (disabled) return

    if (isOpen) {
      setIsOpen(false)
      return
    }

    syncDraftFromProps()
    positionDropdown()
    setIsOpen(true)
  }

  function isDateDisabled(dateValue: string) {
    if (maxDateValue && dateValue > maxDateValue) return true
    if (minDateValue && dateValue < minDateValue) return true
    return false
  }

  function isMonthDisabled(year: number, month: number) {
    const monthKey = getMonthKey(year, month)
    if (maxDateValue && monthKey > maxDateValue.slice(0, 7)) return true
    if (minDateValue && monthKey < minDateValue.slice(0, 7)) return true
    return false
  }

  function isYearDisabled(year: number) {
    if (maxDateValue && year > Number(maxDateValue.slice(0, 4))) return true
    if (minDateValue && year < Number(minDateValue.slice(0, 4))) return true
    return false
  }

  function getAllowedMonthForYear(year: number, preferredMonth: number) {
    let month = preferredMonth

    if (maxDateValue && year === Number(maxDateValue.slice(0, 4))) {
      month = Math.min(month, Number(maxDateValue.slice(5, 7)) - 1)
    }

    if (minDateValue && year === Number(minDateValue.slice(0, 4))) {
      month = Math.max(month, Number(minDateValue.slice(5, 7)) - 1)
    }

    return month
  }

  function emitChange(start: string, end: string) {
    if (props.mode === 'single') {
      props.onChange(start)
    } else {
      props.onChange({ start, end })
    }
  }

  function emitCommit(start: string, end: string) {
    if (props.mode === 'single') {
      props.onCommit?.(start)
    } else {
      props.onCommit?.({ start, end })
    }
  }

  function closeDropdown() {
    if (!inline) {
      setIsOpen(false)
    }
  }

  function handleDateClick(day: number) {
    const dateValue = `${viewDate.getFullYear()}-${pad2(viewDate.getMonth() + 1)}-${pad2(day)}`
    if (isDateDisabled(dateValue)) return

    if (props.mode === 'single') {
      setDraftStart(dateValue)
      return
    }

    if (selectingStart || !draftStart || (draftStart && draftEnd)) {
      setDraftStart(dateValue)
      setDraftEnd('')
      setSelectingStart(false)
      return
    }

    if (dateValue < draftStart) {
      setDraftStart(dateValue)
      setDraftEnd(draftStart)
    } else {
      setDraftEnd(dateValue)
    }
    setSelectingStart(true)
  }

  function handleQuickOption(days: number) {
    if (days === 0) {
      setDraftStart('')
      setDraftEnd('')
      emitChange('', '')
      emitCommit('', '')
      closeDropdown()
      return
    }

    const end = parseDateValue(maxDateValue || todayValue) || new Date()
    const start = days === 1 ? end : addDays(end, -days + 1)
    const startValue = formatDateValue(start)
    const endValue = formatDateValue(end)

    setDraftStart(startValue)
    setDraftEnd(endValue)
    emitChange(startValue, endValue)
    emitCommit(startValue, endValue)
    closeDropdown()
  }

  function handleToday() {
    const today = parseDateValue(maxDateValue || todayValue) || new Date()
    const todayString = formatDateValue(today)

    if (props.mode === 'single') {
      setDraftStart(todayString)
    } else {
      setDraftStart(todayString)
      setDraftEnd(todayString)
      setSelectingStart(true)
    }

    setViewDate(new Date(today.getFullYear(), today.getMonth(), 1))
    setPickerView('day')
  }

  function handleClear(event?: MouseEvent) {
    event?.stopPropagation()
    setDraftStart('')
    setDraftEnd('')
    setSelectingStart(true)
    emitChange('', '')
  }

  function handleCommit() {
    if (props.mode === 'single') {
      if (!draftStart || loading) return
      emitChange(draftStart, '')
      emitCommit(draftStart, '')
      closeDropdown()
      return
    }

    if ((!draftStart && !draftEnd) || loading) return

    const start = draftStart && draftEnd && draftEnd < draftStart ? draftEnd : draftStart
    const end = draftStart && draftEnd && draftEnd < draftStart ? draftStart : draftEnd
    emitChange(start, end)
    emitCommit(start, end)
    closeDropdown()
  }

  function goToPreviousMonth() {
    setViewDate(prev => new Date(prev.getFullYear(), prev.getMonth() - 1, 1))
  }

  function goToNextMonth() {
    const next = new Date(viewDate.getFullYear(), viewDate.getMonth() + 1, 1)
    if (isMonthDisabled(next.getFullYear(), next.getMonth())) return
    setViewDate(next)
  }

  function openYearView() {
    setYearPageStart(getYearPageStart(viewDate.getFullYear()))
    setPickerView('year')
  }

  function canGoNextMonth() {
    const next = new Date(viewDate.getFullYear(), viewDate.getMonth() + 1, 1)
    return !isMonthDisabled(next.getFullYear(), next.getMonth())
  }

  function canGoNextYearPage() {
    if (!maxDateValue) return true
    return yearPageStart + 12 <= Number(maxDateValue.slice(0, 4))
  }

  function selectYear(year: number) {
    if (isYearDisabled(year)) return

    const month = getAllowedMonthForYear(year, viewDate.getMonth())
    setViewDate(new Date(year, month, 1))
    setPickerView('month')
  }

  function selectMonth(month: number) {
    if (isMonthDisabled(viewDate.getFullYear(), month)) return
    setViewDate(new Date(viewDate.getFullYear(), month, 1))
    setPickerView('day')
  }

  function formatDisplayDate(dateValue: string) {
    const date = parseDateValue(dateValue)
    if (!date) return ''
    return `${date.getFullYear()}/${date.getMonth() + 1}/${date.getDate()}`
  }

  function getDisplayText() {
    if (props.mode === 'single') {
      return selectedStart ? formatDisplayDate(selectedStart) : placeholder
    }

    if (!selectedStart && !selectedEnd) return placeholder
    if (selectedStart && selectedEnd) return `${formatDisplayDate(selectedStart)} - ${formatDisplayDate(selectedEnd)}`
    if (selectedStart) return `${formatDisplayDate(selectedStart)} - ?`
    return `? - ${formatDisplayDate(selectedEnd)}`
  }

  function renderDayView() {
    const year = viewDate.getFullYear()
    const month = viewDate.getMonth()
    const daysInMonth = new Date(year, month + 1, 0).getDate()
    const firstDay = new Date(year, month, 1).getDay()
    const cells: Array<number | null> = []

    for (let index = 0; index < firstDay; index++) {
      cells.push(null)
    }

    for (let day = 1; day <= daysInMonth; day++) {
      cells.push(day)
    }

    while (cells.length < 42) {
      cells.push(null)
    }

    return (
      <>
        <div className="calendar-weekdays">
          {WEEKDAY_NAMES.map(name => (
            <div key={name} className="weekday-header">{name}</div>
          ))}
        </div>
        <div className="calendar-grid">
          {cells.map((day, index) => {
            if (!day) {
              return <div key={`empty-${index}`} className="calendar-day empty" />
            }

            const dateValue = `${year}-${pad2(month + 1)}-${pad2(day)}`
            const disabledDay = isDateDisabled(dateValue)
            const isToday = dateValue === todayValue
            const isSelected = props.mode === 'single' && draftStart === dateValue
            const isStart = props.mode === 'range' && draftStart === dateValue
            const isEnd = props.mode === 'range' && draftEnd === dateValue
            const isInRange = props.mode === 'range' && draftStart && draftEnd && dateValue >= draftStart && dateValue <= draftEnd

            return (
              <button
                key={dateValue}
                type="button"
                className={joinClassNames(
                  'calendar-day',
                  'valid',
                  isToday && 'today',
                  disabledDay && 'disabled',
                  isSelected && 'selected',
                  isInRange && 'in-range',
                  isStart && 'start',
                  isEnd && 'end',
                )}
                onClick={() => handleDateClick(day)}
                disabled={disabledDay}
                title={disabledDay ? '未来时间不可选' : undefined}
              >
                {day}
              </button>
            )
          })}
        </div>
      </>
    )
  }

  function renderMonthView() {
    return (
      <div className="picker-choice-grid month-grid">
        {SHORT_MONTH_NAMES.map((name, month) => {
          const disabledMonth = isMonthDisabled(viewDate.getFullYear(), month)
          return (
            <button
              key={name}
              type="button"
              className={joinClassNames('picker-choice', month === viewDate.getMonth() && 'selected')}
              onClick={() => selectMonth(month)}
              disabled={disabledMonth}
            >
              {name}
            </button>
          )
        })}
      </div>
    )
  }

  function renderYearView() {
    const years = Array.from({ length: 12 }, (_, index) => yearPageStart + index)
    return (
      <div className="picker-choice-grid year-grid">
        {years.map(year => {
          const disabledYear = isYearDisabled(year)
          return (
            <button
              key={year}
              type="button"
              className={joinClassNames('picker-choice', year === viewDate.getFullYear() && 'selected')}
              onClick={() => selectYear(year)}
              disabled={disabledYear}
            >
              {year}
            </button>
          )
        })}
      </div>
    )
  }

  function renderCalendarBody() {
    if (pickerView === 'year') return renderYearView()
    if (pickerView === 'month') return renderMonthView()
    return renderDayView()
  }

  function renderHeaderTitle() {
    if (pickerView === 'year') {
      return `${yearPageStart} - ${yearPageStart + 11}`
    }

    if (pickerView === 'month') {
      return `${viewDate.getFullYear()}年`
    }

    return `${viewDate.getFullYear()}年 ${MONTH_NAMES[viewDate.getMonth()]}`
  }

  function renderPanel() {
    const confirmDisabled = props.mode === 'single'
      ? !draftStart || loading
      : (!draftStart && !draftEnd) || loading

    return (
      <>
        {shouldShowQuickOptions && (
          <div className="quick-options">
            {DEFAULT_QUICK_OPTIONS.map(option => (
              <button
                key={option.label}
                type="button"
                className="quick-option"
                onClick={() => handleQuickOption(option.days)}
              >
                {option.label}
              </button>
            ))}
          </div>
        )}
        <div className={joinClassNames('calendar-section', panelClassName)}>
          <div className="calendar-header">
            <button
              type="button"
              className="nav-btn"
              onClick={() => {
                if (pickerView === 'year') {
                  setYearPageStart(prev => prev - 12)
                } else if (pickerView === 'month') {
                  setViewDate(prev => new Date(prev.getFullYear() - 1, prev.getMonth(), 1))
                } else {
                  goToPreviousMonth()
                }
              }}
            >
              <ChevronLeft size={16} />
            </button>
            <button type="button" className="month-year" onClick={openYearView}>
              {renderHeaderTitle()}
            </button>
            <button
              type="button"
              className="nav-btn"
              onClick={() => {
                if (pickerView === 'year') {
                  if (canGoNextYearPage()) setYearPageStart(prev => prev + 12)
                } else if (pickerView === 'month') {
                  const nextYear = viewDate.getFullYear() + 1
                  if (!isYearDisabled(nextYear)) setViewDate(prev => new Date(prev.getFullYear() + 1, prev.getMonth(), 1))
                } else {
                  goToNextMonth()
                }
              }}
              disabled={
                pickerView === 'year'
                  ? !canGoNextYearPage()
                  : pickerView === 'month'
                    ? isYearDisabled(viewDate.getFullYear() + 1)
                    : !canGoNextMonth()
              }
            >
              <ChevronRight size={16} />
            </button>
          </div>

          {pickerView === 'month' && (
            <button type="button" className="subview-back-btn" onClick={openYearView}>
              选择年份
            </button>
          )}

          {renderCalendarBody()}

          <div className="selection-hint">
            {props.mode === 'range'
              ? (selectingStart ? '请选择开始日期' : '请选择结束日期')
              : '请选择要跳转的日期'}
          </div>

          <div className="calendar-footer">
            {showToday && (
              <button type="button" className="date-jump-today" onClick={handleToday}>
                今天
              </button>
            )}
            {showClear && (
              <button type="button" className="date-clear-action" onClick={handleClear}>
                清除
              </button>
            )}
            <button
              type="button"
              className="date-jump-confirm"
              onClick={handleCommit}
              disabled={confirmDisabled}
            >
              {loading ? <Loader2 size={14} className="spin" /> : null}
              {loading ? `${confirmLabel}中...` : confirmLabel}
            </button>
          </div>
        </div>
      </>
    )
  }

  const hasCommittedValue = props.mode === 'single'
    ? Boolean(selectedStart)
    : Boolean(selectedStart || selectedEnd)

  const rootClassName = joinClassNames(
    'app-date-picker',
    inline && 'app-date-picker-inline',
    isOpen && 'open',
    className,
  )

  if (inline) {
    return (
      <div className={rootClassName} ref={containerRef}>
        <div className={joinClassNames('picker-dropdown', 'picker-dropdown-inline', dropdownClassName)}>
          {renderPanel()}
        </div>
      </div>
    )
  }

  return (
    <div className={rootClassName} ref={containerRef}>
      <div className="picker-trigger-shell">
        <button
          type="button"
          className={joinClassNames(
            'picker-trigger',
            `picker-trigger-${triggerVariant}`,
            hasCommittedValue && 'has-value',
            hasCommittedValue && showClear && triggerVariant !== 'icon' && 'has-clear',
            isOpen && 'active',
            triggerClassName,
          )}
          ref={triggerRef}
          onClick={openPicker}
          disabled={disabled}
          aria-label={ariaLabel || placeholder}
          aria-expanded={isOpen}
          data-tooltip={triggerVariant === 'icon' ? placeholder : undefined}
        >
          {loading ? <Loader2 size={triggerVariant === 'icon' ? 18 : 14} className="spin" /> : (triggerIcon || <Calendar size={triggerVariant === 'icon' ? 18 : 14} />)}
          {triggerVariant !== 'icon' && <span className="picker-text">{getDisplayText()}</span>}
        </button>
        {showClear && hasCommittedValue && triggerVariant !== 'icon' && !disabled && (
          <button type="button" className="clear-btn" onClick={handleClear} aria-label="清除日期">
            <X size={12} />
          </button>
        )}
      </div>

      {isOpen && (
        <div className={joinClassNames('picker-dropdown', dropdownClassName)} style={dropdownStyle}>
          {renderPanel()}
        </div>
      )}
    </div>
  )
}

export default AppDatePicker
