export type MeetingAnswerSource = Readonly<{
  title: string;
  url: string;
  publishedAt?: string;
}>;

export type MeetingAnswerMedia = Readonly<{
  kind: 'image' | 'video' | 'web';
  title: string;
  url: string;
  caption?: string;
}>;

export type MeetingProposedAction = Readonly<{ kind: 'end_meeting' | 'open_audio_folder' | 'play_audio' }>;

export type MeetingAnswer = Readonly<{
  fullAnswer?: string;
  spokenAnswer: string;
  title: string;
  bullets: readonly string[];
  sources: readonly MeetingAnswerSource[];
  media: readonly MeetingAnswerMedia[];
  action: MeetingProposedAction | null;
}>;

export const EMPTY_MODEL_REPLY = '本轮任务已完成，但模型没有返回文字说明';
export const EMPTY_MEETING_SPOKEN = '我刚才没组织好答案，请再问我一次。';
const SPOKEN_ANSWER_LIMIT = 120;

function text(value: unknown, maximum: number): string {
  return typeof value === 'string' ? value.trim().slice(0, maximum) : '';
}

function displayText(value: unknown, maximum: number): string {
  return text(value, maximum)
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/https?:\/\/\S+/gi, ' ')
    .replace(/[*_`#>]/g, '')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function isUnusableMeetingReply(reply: string): boolean {
  return !reply.trim() || reply.includes(EMPTY_MODEL_REPLY);
}

export function speakableMeetingText(value: string, maximum = SPOKEN_ANSWER_LIMIT): string {
  const cleaned = value
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/https?:\/\/\S+/gi, ' ')
    .replace(/[*_`#>\[\]()]/g, '')
    .replace(/\p{Extended_Pictographic}/gu, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (isUnusableMeetingReply(cleaned)) return EMPTY_MEETING_SPOKEN;
  if (!cleaned) return '';
  if (cleaned.length <= maximum) return cleaned;
  const sliced = cleaned.slice(0, maximum);
  const sentence = Math.max(sliced.lastIndexOf('。'), sliced.lastIndexOf('！'), sliced.lastIndexOf('？'));
  return (sentence >= 8 ? sliced.slice(0, sentence + 1) : sliced).trim();
}

function emptyMeetingAnswer(fallbackTitle: string): MeetingAnswer {
  return {
    spokenAnswer: EMPTY_MEETING_SPOKEN,
    title: fallbackTitle || '请再问一次',
    bullets: [],
    sources: [],
    media: [],
    action: null,
  };
}

function httpsUrl(value: unknown): string {
  const candidate = text(value, 2_000);
  try {
    const url = new URL(candidate);
    if (url.protocol !== 'https:' || !publicHostname(url.hostname)) return '';
    url.hash = '';
    for (const parameter of [...url.searchParams.keys()]) {
      if (/^(utm_|fbclid$|gclid$|mc_cid$|mc_eid$)/i.test(parameter)) {
        url.searchParams.delete(parameter);
      }
    }
    return url.toString();
  } catch {
    return '';
  }
}

function publicHostname(hostnameValue: string): boolean {
  const hostname = hostnameValue.toLocaleLowerCase('en-US').replace(/^\[|\]$/g, '');
  if (hostname === 'localhost' || hostname.endsWith('.localhost') || hostname.endsWith('.local')) return false;
  if (hostname === '::1' || hostname === '0.0.0.0') return false;
  const octets = hostname.split('.').map(Number);
  if (octets.length !== 4 || octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)) return true;
  return !(octets[0] === 10
    || octets[0] === 127
    || (octets[0] === 169 && octets[1] === 254)
    || (octets[0] === 172 && (octets[1] ?? 0) >= 16 && (octets[1] ?? 0) <= 31)
    || (octets[0] === 192 && octets[1] === 168));
}

function parsedObject(candidate: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(candidate);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

function answerShape(payload: Record<string, unknown>): boolean {
  return typeof payload.spokenAnswer === 'string' && payload.spokenAnswer.trim().length > 0;
}

function balancedJsonObject(candidate: string, start: number): Record<string, unknown> | null {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < candidate.length; index += 1) {
    const character = candidate[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (character === '\\') escaped = true;
      else if (character === '"') inString = false;
      continue;
    }
    if (character === '"') {
      inString = true;
      continue;
    }
    if (character === '{') depth += 1;
    else if (character === '}') {
      depth -= 1;
      if (depth === 0) return parsedObject(candidate.slice(start, index + 1));
      if (depth < 0) return null;
    }
  }
  return null;
}

function jsonObject(reply: string): Record<string, unknown> | null {
  const trimmed = reply.trim();
  const candidate = trimmed.startsWith('```')
    ? trimmed.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '')
    : trimmed.replace(/\s*```\s*$/, '');
  const direct = parsedObject(candidate);
  if (direct && answerShape(direct)) return direct;
  if (candidate.length > 64_000) return null;

  // Some providers prepend an explanation even when JSON-only output was
  // requested. Recover the final structured object so private model reasoning
  // and protocol chatter never reach the meeting screen or the spoken record.
  for (let start = candidate.lastIndexOf('{'), attempts = 0; start >= 0 && attempts < 64; attempts += 1, start = start === 0 ? -1 : candidate.lastIndexOf('{', start - 1)) {
    const recovered = balancedJsonObject(candidate, start);
    if (recovered && answerShape(recovered)) return recovered;
  }
  return null;
}

export function parseMeetingAnswer(reply: string, fallbackTitle: string, evidenceUrls: ReadonlySet<string> = new Set()): MeetingAnswer {
  if (isUnusableMeetingReply(reply)) return emptyMeetingAnswer(fallbackTitle);
  const fallback = speakableMeetingText(text(reply, 20_000)) || EMPTY_MEETING_SPOKEN;
  const payload = jsonObject(reply);
  const evidence = new Set([...evidenceUrls].map(httpsUrl).filter(Boolean));
  if (!payload) return { spokenAnswer: reply.trim().startsWith('{') || reply.trim().startsWith('```') ? '我刚才没组织好答案，请再问我一次。' : fallback, title: fallbackTitle, bullets: [], sources: [], media: [], action: null };

  const spokenAnswer = speakableMeetingText(text(payload.spokenAnswer, 20_000) || fallback) || EMPTY_MEETING_SPOKEN;
  const bullets = Array.isArray(payload.bullets)
    ? [...new Set(payload.bullets.map((item) => displayText(item, 40)).filter(Boolean))].slice(0, 4)
    : [];
  const sourceCandidates = Array.isArray(payload.sources) ? payload.sources.flatMap((item) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return [];
    const source = item as Record<string, unknown>;
    const url = httpsUrl(source.url);
    if (!url || !evidence.has(url)) return [];
    return [{ title: text(source.title, 300) || new URL(url).hostname, url, publishedAt: text(source.publishedAt, 100) || undefined }];
  }) : [];
  const sources = [...new Map(sourceCandidates.map((source) => [source.url, source])).values()].slice(0, 8);
  const mediaCandidates = Array.isArray(payload.media) ? payload.media.flatMap((item) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return [];
    const medium = item as Record<string, unknown>;
    const url = httpsUrl(medium.url);
    const kind = medium.kind;
    if (!url || !evidence.has(url) || !['image', 'video', 'web'].includes(String(kind))) return [];
    return [{
      kind: kind as MeetingAnswerMedia['kind'],
      title: text(medium.title, 300) || new URL(url).hostname,
      url,
      caption: text(medium.caption, 500) || undefined,
    }];
  }) : [];
  const media = [...new Map(mediaCandidates.map((medium) => [`${medium.kind}:${medium.url}`, medium])).values()].slice(0, 8);
  const action = parseAction(payload.action);
  return {
    spokenAnswer,
    fullAnswer: speakableMeetingText(text(payload.spokenAnswer, 20_000), 20_000),
    title: displayText(payload.title, 16) || displayText(fallbackTitle, 16) || '会议回答',
    bullets,
    sources,
    media,
    action,
  };
}

function parseAction(value: unknown): MeetingProposedAction | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const action = value as Record<string, unknown>;
  const kind = text(action.kind, 100);
  if (['end_meeting', 'open_audio_folder', 'play_audio'].includes(kind)) {
    return { kind } as MeetingProposedAction;
  }
  return null;
}
