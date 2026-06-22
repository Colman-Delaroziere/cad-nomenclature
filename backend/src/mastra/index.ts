
import { Mastra } from '@mastra/core/mastra';
import { partAgent } from './agents/part-agent';

export const mastra = new Mastra({
  agents: { partAgent },
})
        
