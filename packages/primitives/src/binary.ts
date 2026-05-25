// Binary frame encoding/decoding — channel ID prefix

export function encodeBinaryFrame(channelId: number, payload: Buffer): Buffer {
  const frame = Buffer.alloc(1 + payload.length)
  frame[0] = channelId & 0xff
  payload.copy(frame, 1)
  return frame
}

export function decodeBinaryFrame(frame: Buffer): { channelId: number; payload: Buffer } {
  return {
    channelId: frame[0],
    payload: frame.subarray(1)
  }
}

// Channel ID registry for binary channels
export function createBinaryChannelRegistry() {
  let nextId = 1
  const nameToId = new Map<string, number>()
  const idToName = new Map<number, string>()

  const assignChannelId = (channelName: string): number => {
    if (nameToId.has(channelName)) return nameToId.get(channelName)!
    const id = nextId++
    nameToId.set(channelName, id)
    idToName.set(id, channelName)
    return id
  }

  const getChannelId = (channelName: string): number | undefined => nameToId.get(channelName)
  const getChannelName = (channelId: number): string | undefined => idToName.get(channelId)

  return { assignChannelId, getChannelId, getChannelName }
}
