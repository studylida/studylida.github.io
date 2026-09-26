import { getCollection } from 'astro:content';

// prerender = true: 빌드 시점에 정적 JSON 파일로 딱 한 번 생성하라는 의미입니다.
export const prerender = true;

export async function GET() {
  // 1. 임시저장(draft)이 아닌 모든 글 가져오기
  const posts = await getCollection('posts', ({ data }) => !data.draft);

  // 2. 검색 및 매칭에 꼭 필요한 가벼운 데이터만 선별 (용량 최소화)
  const searchIndex = posts.map((post) => ({
    slug: post.id,
    title: post.data.title,
    description: post.data.description,
    tags: post.data.tags,
    categories: post.data.categories,
    category: post.data.categories[0] || 'General',
  }));

  // 3. 브라우저가 JSON으로 인식할 수 있도록 반환
  return new Response(JSON.stringify(searchIndex), {
    status: 200,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'public, max-age=3600', // 브라우저 캐싱
    },
  });
}