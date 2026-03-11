import type { Meta, StoryObj } from 'storybook-solidjs-vite'
import App from './App'

const meta = {
  title: 'Example/App',
  component: App,
  tags: ['autodocs']
} satisfies Meta<typeof App>

export default meta
type Story = StoryObj<typeof meta>

/**
 * The primary story for the App component.
 */
export const Primary: Story = {}
