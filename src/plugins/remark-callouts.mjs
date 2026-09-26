import { visit } from 'unist-util-visit';

const ALERT_CONFIG = {
  note: { title: '참고 (Note)', icon: 'ℹ️' },
  tip: { title: '팁 (Tip)', icon: '💡' },
  important: { title: '중요 (Important)', icon: '❗' },
  warning: { title: '주의 (Warning)', icon: '⚠️' },
  caution: { title: '경고 (Caution)', icon: '🛑' }
};

/**
 * Remark plugin to transform GitHub-style alert blockquotes (> [!NOTE], > [!TIP], etc.)
 * into beautifully styled callout containers with icons and headers.
 */
export default function remarkCallouts() {
  return (tree) => {
    visit(tree, 'blockquote', (node) => {
      const firstP = node.children?.[0];
      if (firstP?.type !== 'paragraph') return;
      const firstText = firstP.children?.[0];
      if (firstText?.type !== 'text') return;

      const match = firstText.value.match(/^\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\](?:\r?\n|\s*)/i);
      if (match) {
        const type = match[1].toLowerCase();
        firstText.value = firstText.value.slice(match[0].length);
        if (!firstText.value.trim() && firstP.children.length > 1) {
          firstP.children.shift();
        }

        node.data = node.data || {};
        node.data.hName = 'div';
        node.data.hProperties = {
          class: `markdown-callout markdown-callout-${type}`
        };

        const conf = ALERT_CONFIG[type] || ALERT_CONFIG.note;
        const headerNode = {
          type: 'paragraph',
          data: {
            hName: 'div',
            hProperties: {
              class: 'callout-header'
            }
          },
          children: [
            { type: 'text', value: `${conf.icon} ${conf.title}` }
          ]
        };
        node.children.unshift(headerNode);
      }
    });
  };
}
