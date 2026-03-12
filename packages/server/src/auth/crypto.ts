import crypto from 'node:crypto'

export function generateChallenge(): string {
  return crypto.randomBytes(32).toString('hex')
}

export function verifySignature(publicKeyHex: string, challenge: string, signatureHex: string): boolean {
  try {
    const publicKey = Buffer.from(publicKeyHex, 'hex')
    const signature = Buffer.from(signatureHex, 'hex')
    const data = Buffer.from(challenge, 'utf-8')
    return crypto.verify(
      null,
      data,
      {
        key: crypto.createPublicKey({
          key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), publicKey]),
          format: 'der',
          type: 'spki'
        }),
        dsaEncoding: undefined as never
      },
      signature
    )
  } catch {
    return false
  }
}

export function generateKeyPair(): { publicKey: string; privateKey: crypto.KeyObject } {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519')
  const rawPub = publicKey.export({ type: 'spki', format: 'der' }).subarray(-32)
  return { publicKey: rawPub.toString('hex'), privateKey }
}

export function sign(privateKey: crypto.KeyObject, data: string): string {
  const sig = crypto.sign(null, Buffer.from(data, 'utf-8'), privateKey)
  return sig.toString('hex')
}
