import { notImplemented } from '../errors.js'
import type { AdvancedService } from './types.js'

export class NotImplementedAdvancedService implements AdvancedService {
  async search(): Promise<never> {
    throw notImplemented('search')
  }

  async stats(): Promise<never> {
    throw notImplemented('stats')
  }

  async exportChat(): Promise<never> {
    throw notImplemented('export')
  }

  async moments(): Promise<never> {
    throw notImplemented('moments')
  }

  async report(): Promise<never> {
    throw notImplemented('report')
  }

  async mcpServe(): Promise<never> {
    throw notImplemented('mcp serve')
  }
}

export const advancedService = new NotImplementedAdvancedService()
