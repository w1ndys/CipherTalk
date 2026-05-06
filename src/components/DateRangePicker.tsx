import AppDatePicker, { type DateRangeValue } from './AppDatePicker'

interface DateRangePickerProps {
  startDate: string
  endDate: string
  onStartDateChange: (date: string) => void
  onEndDateChange: (date: string) => void
  onRangeComplete?: () => void
}

function DateRangePicker({
  startDate,
  endDate,
  onStartDateChange,
  onEndDateChange,
  onRangeComplete,
}: DateRangePickerProps) {
  const handleChange = (range: DateRangeValue) => {
    onStartDateChange(range.start)
    onEndDateChange(range.end)
  }

  const handleCommit = (range: DateRangeValue) => {
    if ((range.start && range.end) || (!range.start && !range.end)) {
      onRangeComplete?.()
    }
  }

  return (
    <AppDatePicker
      mode="range"
      className="date-range-picker"
      range={{ start: startDate, end: endDate }}
      onChange={handleChange}
      onCommit={handleCommit}
      placeholder="选择时间范围"
      confirmLabel="确认"
    />
  )
}

export default DateRangePicker
