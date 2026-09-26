import { defineCollection, z } from 'astro:content';

// 게시글(posts) 컬렉션의 메타데이터(Frontmatter) 스키마 정의
const postsCollection = defineCollection({
  type: 'content', // 마크다운/MDX 콘텐츠
  schema: z.object({
    title: z.string(),
    description: z.string(),
    pubDate: z.coerce.date(),
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