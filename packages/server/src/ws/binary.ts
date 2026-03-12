// Binary frame encoding/decoding — channel ID prefix

export function encodeBinaryFrame(_channelId: number, _payload: Buffer): Buffer {
  throw new Error('not implemented')
}

export function decodeBinaryFrame(_frame: Buffer): { channelId: number; payload: Buffer } {
  throw new Error('not implemented')
}
