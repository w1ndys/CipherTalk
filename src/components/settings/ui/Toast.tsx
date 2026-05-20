import './Toast.scss'

export interface ToastMessage {
  text: string
  success: boolean
}

interface ToastProps {
  message: ToastMessage | null
}

function Toast({ message }: ToastProps) {
  if (!message) return null

  return (
    <div className={`message-toast ${message.success ? 'success' : 'error'}`}>
      {message.text}
    </div>
  )
}

export default Toast
