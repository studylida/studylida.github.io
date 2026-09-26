import { defineCollection, z } from 'astro:content';

/**
 * YAML의 따옴표 유무(Date vs String) 및 빌드 환경(로컬 KST vs CI/CD UTC)에 무관하게
 * 작성자가 기재한 연-월-일 시:분:초를 한국 표준시(KST, UTC+9)로 안전하고 일관되게 변환합니다.
 */
export function parseKSTDate(val: unknown): Date {
  if (val instanceof Date) {
    // YAML 파서가 unquoted 날짜를 UTC 기준으로 해석하여 넘겨준 경우, 기재된 숫자 그대로 KST(+09:00)로 보정
    const y = val.getUTCFullYear();
    const m = String(val.getUTCMonth() + 1).padStart(2, '0');
    const d = String(val.getUTCDate()).padStart(2, '0');
    const h = String(val.getUTCHours()).padStart(2, '0');
    const min = String(val.getUTCMinutes()).padStart(2, '0');
    const s = String(val.getUTCSeconds()).padStart(2, '0');
    return new Date(`${y}-${m}-${d}T${h}:${min}:${s}+09:00`);
  }

  if (typeof val === 'string') {
    const trimmed = val.trim();
    // 타임존(+09:00, Z 등)이 이미 명시된 경우 그대로 파싱
    if (trimmed.includes('Z') || /[+-]\d{2}:\d{2}$/.test(trimmed)) {
      return new Date(trimmed);
    }

    // YYYY-MM-DD HH:mm:ss 또는 YYYY-MM-DD 형태를 KST(+09:00)로 해석
    const match = trimmed.match(/^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?/);
    if (match) {
      const [, y, m, d, h = '00', min = '00', s = '00'] = match;
      return new Date(`${y}-${m}-${d}T${h}:${min}:${s}+09:00`);
    }

    return new Date(trimmed);
  }

  return new Date(val as any);
}

// 게시글(posts) 컬렉션의 메타데이터(Frontmatter) 스키마 정의
const postsCollection = defineCollection({
  type: 'content', // 마크다운/MDX 콘텐츠
  schema: z.object({
    title: z.string(),
    description: z.string(),
    pubDate: z.preprocess(parseKSTDate, z.date()),
    // 태그 배열 (기본값 빈 배열)
    tags: z.array(z.string()).default([]),
    // 카테고리 (기본값 'General')
    category: z.string().default('General'),
    // 임시 저장 여부 (true면 블로그 목록에서 숨김)
    draft: z.boolean().default(false),
  }),
});

// Astro가 인식할 수 있도록 collections 객체로 내보내기
export const collections = {
  posts: postsCollection,
};