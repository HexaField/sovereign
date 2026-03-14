// Speaker label management — §8.2.3

export interface SpeakerLabels {
  [speakerId: string]: string
}

export function createSpeakerService(_dataDir: string): {
  getLabels(orgId: string): Promise<SpeakerLabels>
  setLabels(orgId: string, meetingId: string, labels: SpeakerLabels): Promise<void>
  getOrgHistory(orgId: string): Promise<SpeakerLabels>
} {
  throw new Error('Not implemented')
}
