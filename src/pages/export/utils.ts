export function getAvatarLetter(name: string) {
  if (!name) return '?'
  return [...name][0] || '?'
}
