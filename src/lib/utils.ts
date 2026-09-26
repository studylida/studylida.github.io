import type { CollectionEntry } from 'astro:content';

/**
 * 게시글을 최신 순(시간 포함 내림차순)으로 안전하게 정렬합니다.
 * 발행 시간이 완전히 같을 경우, 글 제목(title) 가나다 순으로 2차 정렬하여 순서가 흔들리지 않게 보장합니다.
 */
export function sortPosts(posts: CollectionEntry<'posts'>[]) {
  return [...posts].sort((a, b) => {
    const timeDiff = b.data.pubDate.getTime() - a.data.pubDate.getTime();
    if (timeDiff !== 0) {
      return timeDiff;
    }
    return a.data.title.localeCompare(b.data.title, 'ko');
  });
}

/**
 * 날짜 표시 포맷 함수
 */
export function formatDate(date: Date) {
  return date.toLocaleDateString('ko-KR', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  });
}
