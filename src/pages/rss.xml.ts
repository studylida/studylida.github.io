import rss from '@astrojs/rss';
import { getCollection } from 'astro:content';
import type { APIContext } from 'astro';
import { sortPosts } from '../lib/utils';

export async function GET(context: APIContext) {
  // 1. 임시저장이 아닌 글들을 최신순으로 가져오기
  const posts = await getCollection('posts', ({ data }) => !data.draft);
  const sortedPosts = sortPosts(posts);

  // 2. RSS 규격에 맞게 변환하여 반환
  return rss({
    title: '지식 서재 📚',
    description: '공부한 기술 개념들을 기록하고 연결하는 공간',
    site: context.site ?? 'https://studylida.github.io',
    items: sortedPosts.map((post) => ({
      title: post.data.title,
      description: post.data.description,
      pubDate: post.data.pubDate,
      link: `/posts/${post.slug}/`,
    })),
    customData: `<language>ko-KR</language>`,
  });
}