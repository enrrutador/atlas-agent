/**
 * Atlas Types - Shared interfaces across all modules
 */

// Configuration
export interface AtlasConfig {
  openaiApiKey: string;
  openaiBaseUrl: string;
  modelName: string;
  telegramBotToken: string;
  adminChatId: number;
  port: number;
  nodeEnv: string;
  dataDir: string;
}

// Messages
export interface ToolCall {
  id: string;
  type: 'function';
  function: {
    name: string;
    arguments: string;
  };
}

export interface Message {
  role: 'user' | 'assistant' | 'system' | 'tool';
  content: string | null;
  tool_call_id?: string;
  tool_calls?: ToolCall[];
  timestamp?: number;
  metadata?: Record<string, any>;
}

export interface Conversation {
  chatId: number;
  messages: Message[];
  createdAt: number;
  updatedAt: number;
}

// Skills
export interface Skill {
  name: string;
  description: string;
  parameters: SkillParameter[];
  handler: (args: Record<string, any>) => Promise<any>;
}

export interface SkillParameter {
  name: string;
  type: 'string' | 'number' | 'boolean' | 'object' | 'array';
  description: string;
  required: boolean;
}

// Operations
export interface Operation {
  type: string;
  risk: 'low' | 'medium' | 'high' | 'critical';
  reversible: boolean;
  description: string;
}

// Trust Decision
export interface TrustDecision {
  allowed: boolean;
  reason?: string;
}

// Forge
export interface ForgeInput {
  problem: string;
  context?: string;
  mode?: 'creative' | 'analytical' | 'decision';
}

export interface ForgeOutput {
  decision: 'proceed' | 'forge' | 'autonomous' | 'propose';
  reasoning?: string;
  proposal?: ForgeProposal;
}

export interface ForgeProposal {
  id: string;
  name: string;
  description: string;
  impact: 'low' | 'medium' | 'high';
  risk: 'low' | 'medium' | 'high';
  status: 'pending' | 'approved' | 'rejected';
  createdAt: number;
}

// Memory
export interface MemoryEntry {
  id: string;
  content: string;
  layer: 'episodic' | 'semantic' | 'procedural';
  source: string;
  tags: string[];
  createdAt: number;
  accessedAt: number;
  accessCount: number;
}

// Desktop Automation (cross-platform)
export interface DesktopAutomation {
  click(x: number, y: number, button?: string, clicks?: number): Promise<void>;
  type(text: string, interval?: number): Promise<void>;
  hotkey(keys: string[]): Promise<void>;
  screenshot(savePath?: string): Promise<string>;
  launch(app: string): Promise<void>;
  windowList(): Promise<string[]>;
  windowFocus(title: string): Promise<void>;
  scroll(amount: number, direction?: 'up' | 'down'): Promise<void>;
  ocr(imagePath?: string): Promise<string>;
}

// Log Entry
export interface LogEntry {
  level: 'debug' | 'info' | 'warn' | 'error' | 'critical';
  source: string;
  message: string;
  timestamp: number;
  metadata?: Record<string, any>;
}

// Query Classification
export type QueryCategory = 'general' | 'memory' | 'project' | 'code' | 'web' | 'tool';

export interface ClassificationResult {
  category: QueryCategory;
  confidence: number;
  source: 'regex' | 'llm' | 'fallback';
  subIntent?: string;
  rawResponse?: string;
}

export type DataSource = 'llm' | 'memory_store' | 'file_system' | 'git' | 'web_search' | 'web_scrape' | 'skill_direct' | 'llm_with_context' | 'llm_synthesis' | 'llm_confirm';

export interface SourcePlan {
  source: DataSource;
  confidence: number;
  skillName?: string;
  skillArgs?: Record<string, any>;
}

export interface RoutedResult {
  source: DataSource;
  content: string;
  confidence: number;
  subIntent?: string;
  metadata?: Record<string, any>;
}

export type FeedbackType = 'correction' | 'confirmation' | 'rejection' | 'clarification';

export interface FeedbackEntry {
  id: string;
  query: string;
  category: QueryCategory;
  source: DataSource;
  originalResponse: string;
  feedbackType: FeedbackType;
  userCorrection?: string;
  timestamp: number;
  confidenceAdjustment: number;
}

export interface ConfidenceAdjustment {
  category: QueryCategory;
  source: DataSource;
  delta: number;
  reason: string;
  timestamp: number;
}

export interface AgentTask {
  id: string;
  input: string;
  category: QueryCategory;
  classification: ClassificationResult;
  status: 'pending' | 'running' | 'completed' | 'failed';
  result?: RoutedResult;
  synthesizedResponse?: string;
  startTime: number;
  endTime?: number;
  retries: number;
}

export interface OrchestratorPlan {
  tasks: AgentTask[];
  strategy: 'sequential' | 'parallel' | 'pipeline';
  mergeStrategy: 'concat' | 'summarize' | 'best_confidence';
}
