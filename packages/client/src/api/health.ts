/**
 * Fetches the health status from the API.
 * @returns A promise that resolves to the health status message and status.
 */
export const fetchHealth = async () => {
  const url = import.meta.env.VITE_API_URL || 'https://localhost:3001'
  const res = await fetch(`${url}/health`)
  if (!res.ok) {
    throw new Error('Network response was not ok')
  }
  return res.json() as Promise<{ message: string; status: string }>
}
