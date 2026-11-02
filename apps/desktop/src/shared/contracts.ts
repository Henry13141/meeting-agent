// Narrow bridge contract for the standalone meeting application.
import { z } from 'zod';

export const codeModeSchema = z.enum(['basic', 'professional']);
export type CodeMode = z.infer<typeof codeModeSchema>;

export const codeWorkspaceErrorCodeSchema = z.enum([
  'GIT_COMPONENT_MISSING',
  'GIT_COMPONENT_INVALID_SIGNATURE',
  'GIT_VERSION_UNSUPPORTED',
  'GIT_HEALTHCHECK_FAILED',
  'WORKSPACE_NOT_REPOSITORY',
  'REPOSITORY_ROOT_NOT_AUTHORIZED',
  'REPOSITORY_UNHEALTHY',
  'REPOSITORY_FEATURE_UNSUPPORTED',
  'SNAPSHOT_LIMIT_EXCEEDED',
  'SNAPSHOT_CREATE_FAILED',
  'SNAPSHOT_PATH_INVALID',
  'SNAPSHOT_SCAN_CANCELLED',
  'SNAPSHOT_INTEGRITY_FAILED',
  'SNAPSHOT_SCHEMA_UNSUPPORTED',
  'SNAPSHOT_FOREIGN_WORKSPACE',
  'SNAPSHOT_WORKSPACE_INACCESSIBLE',
  'SNAPSHOT_STATE_INVALID',
  'SNAPSHOT_ROOT_ACCESS_MANUAL_RECOVERY_REQUIRED',
  'SNAPSHOT_ENTRY_UNSUPPORTED',
  'SNAPSHOT_INCOMPLETE_BASELINE',
  'SNAPSHOT_RUN_INTERRUPTED',
  'SNAPSHOT_ROOT_ACCESS_RECOVERED',
  'SNAPSHOT_JOURNAL_INVALID',
  'SNAPSHOT_RECOVERY_REQUIRED',
  'SNAPSHOT_PLATFORM_UNSUPPORTED',
  'CAPABILITY_REVISION_CHANGED',
  'WORKSPACE_CHANGED_EXTERNALLY',
  'WORKSPACE_RUN_ALREADY_ACTIVE',
  'RESTORE_CONFLICT',
  'REMOTE_CAPABILITY_NOT_GRANTED',
  'BASIC_SNAPSHOT_FULL_REQUIRED',
  'WORKSPACE_TRANSACTION_UNRESOLVED',
]);
export type CodeWorkspaceErrorCode = z.infer<typeof codeWorkspaceErrorCodeSchema>;

export const protectionLevelSchema = z.enum([
  'app_snapshot_full',
  'git_aware_full',
  'text_ledger_only',
  'none',
]);

export const codeWorkspaceCapabilitySchema = z.object({
  schemaVersion: z.literal(1),
  revision: z.string().regex(/^[0-9a-f]{64}$/),
  observedAt: z.string().datetime({ offset: true }),
  protectedExecution: z.boolean().optional(),
  git: z.object({
    provider: z.enum(['managed', 'validated_system', 'none']),
    availability: z.enum([
      'ready',
      'missing',
      'unsupported_version',
      'invalid_distribution',
      'temporarily_unavailable',
    ]),
    version: z.string().min(1).max(80).optional(),
  }).strict(),
  repository: z.object({
    kind: z.enum([
      'plain_folder',
      'repo_root',
      'repo_subdirectory',
      'linked_worktree',
      'bare_repo',
      'unhealthy_repo',
      'unsupported_repo',
    ]),
    selectedDirectoryIsAuthorizedRoot: z.boolean(),
    dirty: z.boolean().optional(),
    hasSubmodules: z.boolean().optional(),
    hasLfs: z.boolean().optional(),
    hasCustomFilters: z.boolean().optional(),
  }).strict(),
  protection: z.object({
    basic: protectionLevelSchema,
    professional: protectionLevelSchema,
    coverageExclusions: z.array(z.string().min(1).max(200)).max(20).default([]),
  }).strict(),
  eligibility: z.object({
    basic: z.boolean(),
    professional: z.boolean(),
    worktree: z.boolean(),
    remoteDelivery: z.boolean(),
  }).strict(),
  reasons: z.array(z.object({
    code: codeWorkspaceErrorCodeSchema,
    messageKey: z.string().min(1).max(120),
    remediationAction: z.string().min(1).max(80).optional(),
  }).strict()).max(20),
}).strict();

export type CodeWorkspaceCapability = z.infer<typeof codeWorkspaceCapabilitySchema>;


export const identifierSchema = z.string().uuid();

export const workspaceGrantSchema = z.object({
  schemaVersion: z.literal(1),
  workspaceGrantId: identifierSchema,
  label: z.string()
    .trim()
    .min(1)
    .max(200)
    .refine((value) => !/[\u0000-\u001f\u007f/\\]/.test(value)),
  state: z.literal('active'),
  issuedAt: z.string().datetime({ offset: true }),
}).strict();

export type WorkspaceGrant = z.infer<typeof workspaceGrantSchema>;


export const threadSchema = z.object({
  id: z.string().uuid(),
  workspaceGrantId: identifierSchema,
  projectWorkspaceGrantId: identifierSchema.optional(),
  workspaceLabel: workspaceGrantSchema.shape.label,
  title: z.string().min(1),
  mode: codeModeSchema,
  createdAt: z.number(),
  hasRuns: z.boolean(),
}).strict();

export type AgentThread = z.infer<typeof threadSchema>;
export const threadListSchema = z.array(threadSchema).max(50);

export const conversationThreadRequestSchema = z.object({
  surface: z.enum(['dialog', 'office']),
  contextId: z.string()
    .trim()
    .min(1)
    .max(200)
    .regex(/^[a-zA-Z0-9._:-]+$/),
}).strict();
export type ConversationThreadRequest = z.infer<typeof conversationThreadRequestSchema>;

export const thinkingEffortSchema = z.enum(['low', 'high', 'max']);

export const thinkingConfigSchema = z.discriminatedUnion('enabled', [
  z.object({ enabled: z.literal(false) }),
  z.object({
    enabled: z.literal(true),
    effort: thinkingEffortSchema,
  }),
]);

export type ThinkingConfig = z.infer<typeof thinkingConfigSchema>;

export const modelCapabilitiesSchema = z.object({
  imageInput: z.boolean().optional(),
  toolCalling: z.boolean(),
  streaming: z.boolean(),
  structuredOutput: z.boolean(),
  thinkingEfforts: z.array(thinkingEffortSchema),
});

export const modelProfileSchema = z.object({
  id: z.string().min(1),
  displayName: z.string().min(1),
  description: z.string().min(1),
  compatibilityFamily: z.string().min(1),
  latencyTier: z.enum(['fast', 'standard']),
  costTier: z.enum(['low', 'high']),
  enabled: z.boolean(),
  capabilities: modelCapabilitiesSchema,
});

export type ModelProfile = z.infer<typeof modelProfileSchema>;

export const modelCatalogSchema = z.object({
  revision: z.string().min(1),
  defaultProfileId: z.string().min(1),
  profiles: z.array(modelProfileSchema).min(1),
});

export type ModelCatalog = z.infer<typeof modelCatalogSchema>;

export const runModelReceiptSchema = z.object({
  profileId: z.string().min(1),
  providerModel: z.string().min(1),
  compatibilityFamily: z.string().min(1),
  thinking: thinkingConfigSchema,
  catalogRevision: z.string().min(1),
});

export type RunModelReceipt = z.infer<typeof runModelReceiptSchema>;


export const extensionSkillIdSchema = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/);
export const meetingExtensionCatalogSchema = z.object({
  revision: z.string().min(1).max(128),
  skills: z.array(z.object({ id: extensionSkillIdSchema, name: z.string().max(256),
    description: z.string().max(4_096), tools: z.array(z.string().max(64)).max(256), available: z.boolean() })).max(128),
  tools: z.array(z.object({ name: z.string().max(64), description: z.string().max(16_384),
    serverId: extensionSkillIdSchema, effect: z.enum(['read', 'write']) })).max(256),
  servers: z.array(z.object({ id: extensionSkillIdSchema, status: z.enum(['ready', 'disabled', 'error']),
    error: z.string().max(128).optional() })).max(16),
  error: z.string().max(128).optional(),
});
export type MeetingExtensionCatalog = z.infer<typeof meetingExtensionCatalogSchema>;
export const toolApprovalRequestSchema = z.object({ threadId: identifierSchema, runId: identifierSchema,
  approvalId: identifierSchema, decision: z.enum(['approve', 'deny']) }).strict();
export type ToolApprovalRequest = z.infer<typeof toolApprovalRequestSchema>;
export const meetingToolCallSchema = z.object({ id: identifierSchema, toolName: z.string().max(64),
  serverId: extensionSkillIdSchema, status: z.string().max(64),
  arguments: z.record(z.string(), z.unknown()), createdAt: z.number(),
});
export type MeetingToolCall = z.infer<typeof meetingToolCallSchema>;

// Tools are derived by Runtime from selected, locally configured skills.
export const runRequestSchema = z.object({
  requestId: identifierSchema, threadId: identifierSchema,
  message: z.string().trim().min(1).max(24_000),
  modelProfileId: z.string().min(1), thinking: thinkingConfigSchema,
  catalogRevision: z.string().min(1), capabilityRevision: z.string().regex(/^[0-9a-f]{64}$/),
  accessMode: z.literal('read_only'),
  mcpTools: z.array(z.string().max(170)).max(0).default([]),
  extensionSkillIds: z.array(extensionSkillIdSchema).max(16).optional(),
  knowledgeProjectId: z.string().trim().min(1).max(255).optional(),
}).strict();
export type AgentRunRequest = z.infer<typeof runRequestSchema>;

export const runStatusSchema = z.enum([
  'idle',
  'queued',
  'running',
  'waiting_approval', 'waiting_input',
  'interrupted',
  'cancelling',
  'cancelled',
  'completed',
  'failed',
]);


export const runEventSchema = z.object({
  requestId: z.string().uuid(),
  sequence: z.number().int().positive().optional(),
  runId: identifierSchema.optional(),
  event: z.string().min(1),
  data: z.unknown(),
});

export type AgentRunEvent = z.infer<typeof runEventSchema>;


export const agentRunRecordSchema = z.object({
  id: identifierSchema, requestId: identifierSchema, threadId: identifierSchema,
  status: runStatusSchema, model: runModelReceiptSchema,
  accessMode: z.literal('read_only').optional(),
  createdAt: z.number().int().nonnegative(), updatedAt: z.number().int().nonnegative(),
}).strict();
export type AgentRunRecord = z.infer<typeof agentRunRecordSchema>;

export const persistedRunEventSchema = z.object({
  sequence: z.number().int().positive(),
  event: z.string().min(1),
  data: z.unknown(),
  createdAt: z.number().int().nonnegative(),
});

export const runEventPageSchema = z.object({
  events: z.array(persistedRunEventSchema),
  status: runStatusSchema,
  nextAfter: z.number().int().nonnegative(),
});

export type PersistedRunEvent = z.infer<typeof persistedRunEventSchema>;
export type RunEventPage = z.infer<typeof runEventPageSchema>;


export const runCancelResultSchema = z.object({
  cancelled: z.boolean(),
  run: agentRunRecordSchema,
  event: persistedRunEventSchema.nullable(),
}).strict();
export type RunCancelResult = z.infer<typeof runCancelResultSchema>;


const opaqueBusinessIdentifierSchema = z.string()
  .trim()
  .min(1)
  .max(255)
  .refine(
    (value) => !/[\u0000-\u001f\u007f]/.test(value),
    'business identifiers cannot contain control characters',
  );


export const meetingTranscriptChunkSchema = z.object({
  sequence: z.number().int().positive(),
  speaker: z.string().trim().min(1).max(100),
  text: z.string().trim().min(1).max(4_000),
  capturedAt: z.string().datetime({ offset: true }),
}).strict();
export type MeetingTranscriptChunk = z.infer<typeof meetingTranscriptChunkSchema>;

export const meetingAudioChunkSchema = z.object({
  sequence: z.number().int().positive(),
  mimeType: z.enum(['audio/webm', 'audio/webm;codecs=opus']),
  byteLength: z.number().int().positive().max(10_000_000),
  capturedAt: z.string().datetime({ offset: true }),
}).strict();
export type MeetingAudioChunk = z.infer<typeof meetingAudioChunkSchema>;

export const meetingCapabilitiesSchema = z.object({
  audioRecording: z.literal(true),
  localAsr: z.boolean(),
  speakerDiarization: z.boolean(),
  voiceActivation: z.boolean(),
  avatar: z.object({
    provider: z.enum(['browser', 'local', 'disabled']),
    configured: z.boolean(),
    available: z.boolean(),
  }).strict(),
  tts: z.object({
    provider: z.enum(['browser', 'local', 'disabled']),
    configured: z.boolean(),
    available: z.boolean(),
    voice: z.string().min(1).max(120).optional(),
  }).strict(),
  webSearch: z.object({
    provider: z.literal('disabled'),
    configured: z.boolean(),
  }).strict(),
}).strict();
export type MeetingCapabilities = z.infer<typeof meetingCapabilitiesSchema>;

export const meetingAvatarSpeakRequestSchema = z.object({
  text: z.string().trim().min(1).max(20_000),
  userText: z.string().trim().min(1).max(20_000).optional(),
}).strict();
export type MeetingAvatarSpeakRequest = z.infer<typeof meetingAvatarSpeakRequestSchema>;

export const meetingAvatarTextRequestSchema = z.object({
  text: z.string().trim().min(1).max(20_000),
}).strict();
export type MeetingAvatarTextRequest = z.infer<typeof meetingAvatarTextRequestSchema>;

export const meetingAvatarSpeakResultSchema = z.object({
  accepted: z.literal(true),
  playback: z.enum(['avatar', 'stream', 'fallback']),
}).strict();
export type MeetingAvatarSpeakResult = z.infer<typeof meetingAvatarSpeakResultSchema>;

export const meetingAvatarSessionSchema = z.object({
  provider: z.enum(['browser', 'local', 'disabled']),
  state: z.enum(['idle', 'connecting', 'live', 'fallback', 'error']),
  videoAttached: z.boolean(),
}).strict();
export type MeetingAvatarSession = z.infer<typeof meetingAvatarSessionSchema>;

/** Isolated meeting-stage surface. Not a token, key, or live id. */
export const MEETING_AVATAR_SURFACE_PARTITION = 'meeting-agent-avatar';
export const MEETING_AVATAR_SURFACE_URL = 'meeting-agent://avatar/stage';

export const meetingAvatarLayoutRequestSchema = z.object({
  width: z.number().int().min(0).max(10_000),
  height: z.number().int().min(0).max(10_000),
  top: z.number().int().min(0).max(2_000).optional(),
  bottom: z.number().int().min(0).max(2_000).optional(),
}).strict();
export type MeetingAvatarLayoutRequest = z.infer<typeof meetingAvatarLayoutRequestSchema>;

export const meetingSpeechRequestSchema = z.object({
  text: z.string().trim().min(1).max(2_000),
  meetingId: z.string().uuid().optional(),
}).strict();
export type MeetingSpeechRequest = z.infer<typeof meetingSpeechRequestSchema>;

export const meetingWeatherLookupRequestSchema = z.object({
  question: z.string().trim().min(1).max(500),
}).strict();
export type MeetingWeatherLookupRequest = z.infer<typeof meetingWeatherLookupRequestSchema>;

export const meetingWeatherLookupResultSchema = z.object({
  spokenAnswer: z.string().trim().min(1).max(200),
  title: z.string().trim().min(1).max(16),
  bullets: z.array(z.string().trim().min(1).max(40)).max(4),
  place: z.string().trim().min(1).max(40),
  day: z.enum(['today', 'tomorrow', 'day_after']),
}).strict();
export type MeetingWeatherLookupResult = z.infer<typeof meetingWeatherLookupResultSchema>;

export const meetingSpeechAudioSchema = z.object({
  mimeType: z.literal('audio/mpeg'),
  data: z.instanceof(Uint8Array).refine((value) => value.byteLength >= 16 && value.byteLength <= 2_000_000),
}).strict();
export type MeetingSpeechAudio = z.infer<typeof meetingSpeechAudioSchema>;

export const meetingAvatarAudioChunkSchema = z.object({
  format: z.literal('PCM'),
  sampleRate: z.number().int().min(8_000).max(96_000),
  channels: z.number().int().min(1).max(2),
  data: z.instanceof(Uint8Array).refine((value) => value.byteLength <= 4_000_000),
  endOfSpeech: z.boolean(),
}).strict();
export type MeetingAvatarAudioChunk = z.infer<typeof meetingAvatarAudioChunkSchema>;

export const meetingRecordSchema = z.object({
  schemaVersion: z.literal(1),
  id: z.string().uuid(),
  title: z.string().trim().min(1).max(200),
  status: z.enum(['recording', 'completed']),
  startedAt: z.string().datetime({ offset: true }),
  endedAt: z.string().datetime({ offset: true }).nullable(),
  summaryStatus: z.enum(['pending', 'completed']),
  summary: z.string().max(20_000),
  actionItems: z.array(z.string().trim().min(1).max(500)).max(100),
  archiveDocumentUrl: z.string().url().max(2_000).nullable(),
  knowledgeArticleId: opaqueBusinessIdentifierSchema.nullable(),
  knowledgeStatus: z.enum(['reviewing', 'approved', 'rejected']).nullable(),
  knowledgeProjectName: z.string().trim().min(1).max(200).nullable(),
  knowledgeScopeProjectId: opaqueBusinessIdentifierSchema.nullable(),
  knowledgeScopeProjectName: z.string().trim().min(1).max(200).nullable(),
  transcript: z.array(meetingTranscriptChunkSchema).max(2_000),
  audio: z.array(meetingAudioChunkSchema).max(2_000),
}).strict();
export type MeetingRecord = z.infer<typeof meetingRecordSchema>;

export const meetingCreateRequestSchema = z.object({
  title: z.string().trim().min(1).max(200).optional(),
  knowledgeProjectId: opaqueBusinessIdentifierSchema.optional(),
}).strict();
export type MeetingCreateRequest = z.infer<typeof meetingCreateRequestSchema>;

export const meetingAppendTranscriptRequestSchema = z.object({
  meetingId: z.string().uuid(),
  speaker: z.string().trim().min(1).max(100),
  text: z.string().trim().min(1).max(4_000),
  capturedAt: z.string().datetime({ offset: true }),
}).strict();
export type MeetingAppendTranscriptRequest = z.infer<typeof meetingAppendTranscriptRequestSchema>;

export const meetingAppendAudioRequestSchema = z.object({
  meetingId: z.string().uuid(),
  mimeType: z.enum(['audio/webm', 'audio/webm;codecs=opus']),
  data: z.instanceof(Uint8Array).refine((value) => value.byteLength > 0 && value.byteLength <= 10_000_000),
  capturedAt: z.string().datetime({ offset: true }),
  pcm: z.instanceof(Uint8Array).refine(
    (value) => value.byteLength >= 2 && value.byteLength <= 640_000 && value.byteLength % 2 === 0,
  ).optional(),
  skipTranscription: z.boolean().optional(),
}).strict();
export type MeetingAppendAudioRequest = z.infer<typeof meetingAppendAudioRequestSchema>;

export const meetingVoiceFrameRequestSchema = z.object({
  data: z.instanceof(Uint8Array).refine(
    (value) => value.byteLength >= 2 && value.byteLength <= 256_000 && value.byteLength % 2 === 0,
  ),
  sampleRate: z.number().int().min(8_000).max(48_000),
}).strict();
export type MeetingVoiceFrameRequest = z.infer<typeof meetingVoiceFrameRequestSchema>;

export const meetingVoiceActivationResultSchema = z.object({
  speechDetected: z.boolean(),
  keyword: z.string().trim().min(1).max(100).nullable(),
}).strict();
export type MeetingVoiceActivationResult = z.infer<typeof meetingVoiceActivationResultSchema>;

export const meetingAppendArchiveAudioRequestSchema = z.object({
  meetingId: z.string().uuid(),
  sessionId: z.string().regex(/^\d{8}T\d{6}-[0-9a-f]{8}$/),
  sequence: z.number().int().positive().max(100_000),
  mimeType: z.enum(['audio/webm', 'audio/webm;codecs=opus']),
  data: z.instanceof(Uint8Array).refine((value) => value.byteLength > 0 && value.byteLength <= 10_000_000),
  final: z.boolean(),
}).strict();
export type MeetingAppendArchiveAudioRequest = z.infer<typeof meetingAppendArchiveAudioRequestSchema>;

export const meetingCompleteRequestSchema = z.object({
  meetingId: z.string().uuid(),
  title: z.string().trim().min(1).max(200),
  summary: z.string().max(20_000),
  actionItems: z.array(z.string().trim().min(1).max(500)).max(100),
}).strict();
export type MeetingCompleteRequest = z.infer<typeof meetingCompleteRequestSchema>;

export const meetingSearchRequestSchema = z.object({
  excludeMeetingId: z.string().uuid().optional(),
  query: z.string().trim().min(1).max(500),
  limit: z.number().int().min(1).max(20).default(6),
}).strict();
export type MeetingSearchRequest = z.infer<typeof meetingSearchRequestSchema>;

export const meetingDocumentExportResultSchema = z.object({
  meeting: meetingRecordSchema,
  documentId: z.string().trim().min(1).max(200),
  documentUrl: z.string().url().max(2_000),
}).strict();
export type MeetingDocumentExportResult = z.infer<typeof meetingDocumentExportResultSchema>;

export const meetingAudioExportResultSchema = z.object({
  fileCount: z.number().int().min(1).max(2_000),
}).strict();
export type MeetingAudioExportResult = z.infer<typeof meetingAudioExportResultSchema>;

export const meetingKnowledgeProjectSchema = z.object({
  id: opaqueBusinessIdentifierSchema,
  name: z.string().trim().min(1).max(200),
  slug: z.string().trim().min(1).max(200),
  isDefault: z.boolean(),
}).strict();
export type MeetingKnowledgeProject = z.infer<typeof meetingKnowledgeProjectSchema>;
export const meetingKnowledgeProjectListSchema = z.array(meetingKnowledgeProjectSchema).max(500);

export const meetingKnowledgePublishRequestSchema = z.object({
  meetingId: identifierSchema,
  projectId: opaqueBusinessIdentifierSchema.optional(),
}).strict();
export type MeetingKnowledgePublishRequest = z.infer<typeof meetingKnowledgePublishRequestSchema>;

export const meetingKnowledgePublishResultSchema = z.object({
  articleId: opaqueBusinessIdentifierSchema,
  status: z.literal('reviewing'),
  meeting: meetingRecordSchema,
}).strict();
export type MeetingKnowledgePublishResult = z.infer<typeof meetingKnowledgePublishResultSchema>;


export interface MeetingDesktopApi {
  agent: {
    listModels(): Promise<ModelCatalog>;
    listExtensions(): Promise<MeetingExtensionCatalog>;
    resolveToolApproval(request: ToolApprovalRequest): Promise<{ accepted: boolean }>;
    getToolCalls(threadId: string, runId: string): Promise<MeetingToolCall[]>;
    ensureConversationThread(request: ConversationThreadRequest): Promise<AgentThread>;
    getCodeWorkspaceCapability(threadId: string): Promise<CodeWorkspaceCapability>;
    pickWorkspace(): Promise<WorkspaceGrant | null>;
    createThread(workspaceGrantId: string, mode?: CodeMode): Promise<AgentThread>;
    startRun(request: AgentRunRequest): Promise<{ accepted: true; runId: string }>;
    getRun(threadId: string, runId: string): Promise<AgentRunRecord>;
    getRunEvents(threadId: string, runId: string, after?: number, waitMs?: number): Promise<RunEventPage>;
    cancelRun(threadId: string, runId: string, requestId: string): Promise<RunCancelResult>;
    onRunEvent(listener: (event: AgentRunEvent) => void): () => void;
  };

  meetings: {
    readTranscript(meetingId: string, afterSequence: number): Promise<MeetingRecord>;
    getCapabilities(): Promise<MeetingCapabilities>;
    warmAnswer(): Promise<void>;
    lookupWeather(request: MeetingWeatherLookupRequest): Promise<MeetingWeatherLookupResult>;
    speakAvatar(request: MeetingAvatarSpeakRequest): Promise<MeetingAvatarSpeakResult>;
    sendAvatarText(request: MeetingAvatarTextRequest): Promise<void>;
    synthesizeSpeech(request: MeetingSpeechRequest): Promise<MeetingSpeechAudio>;
    interruptAvatar(): Promise<void>;
    prepareAvatar(): Promise<MeetingAvatarSession>;
    releaseAvatar(): Promise<MeetingAvatarSession>;
    getAvatarSession(): Promise<MeetingAvatarSession>;
    setAvatarLayout(request: MeetingAvatarLayoutRequest): Promise<void>;
    getAvatarUiUrl(): Promise<string>;
    onAvatarAudio(listener: (chunk: MeetingAvatarAudioChunk) => void): () => void;
    onAvatarSession(listener: (session: MeetingAvatarSession) => void): () => void;
    create(request: MeetingCreateRequest): Promise<MeetingRecord>;
    appendTranscript(request: MeetingAppendTranscriptRequest): Promise<MeetingRecord>;
    appendAudio(request: MeetingAppendAudioRequest): Promise<MeetingRecord>;
    analyzeVoice(request: MeetingVoiceFrameRequest): Promise<MeetingVoiceActivationResult>;
    appendArchiveAudio(request: MeetingAppendArchiveAudioRequest): Promise<void>;
    complete(request: MeetingCompleteRequest): Promise<MeetingRecord>;
    list(limit?: number): Promise<MeetingRecord[]>;
    search(request: MeetingSearchRequest): Promise<MeetingRecord[]>;
    openAudioFolder(meetingId: string): Promise<void>;
    playAudio(meetingId: string): Promise<void>;
    exportAudio(meetingId: string): Promise<MeetingAudioExportResult | null>;
    exportDocument(meetingId: string): Promise<MeetingDocumentExportResult>;
    listKnowledgeProjects(): Promise<MeetingKnowledgeProject[]>;
    publishKnowledge(request: MeetingKnowledgePublishRequest): Promise<MeetingKnowledgePublishResult>;
    refreshKnowledge(meetingId: string): Promise<MeetingRecord>;
  };

}
