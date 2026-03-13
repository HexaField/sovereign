// Recording storage service
export function createRecordingsService() {
  return {
    list: async (_orgId: string) => [],
    get: async (_orgId: string, _id: string) => null,
    create: async (_orgId: string, _data: any) => ({ id: '' }),
    delete: async (_orgId: string, _id: string) => {},
    transcribe: async (_orgId: string, _id: string) => {}
  }
}
