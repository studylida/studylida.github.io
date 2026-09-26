import { visit } from 'unist-util-visit';

/**
 * Remark plugin to resolve CommonMark delimiter run parsing limitations with Korean particles and punctuation.
 * Automatically converts unparsed ** into <strong> AST nodes, handling both cross-sibling inline patterns
 * (e.g. **`@RefreshScope`**의) and intra-text patterns (e.g. **스케일 아웃(Scale-Out)**이).
 */
export default function remarkKoreanEmphasis() {
  return (tree) => {
    // Pass 1: Cross-node delimiter pairing
    // Handles cases where ** opens before an inline node (such as inlineCode) and closes in a subsequent text sibling.
    visit(tree, (parent) => {
      if (!parent.children || !Array.isArray(parent.children)) return;

      let i = 0;
      while (i < parent.children.length) {
        const child = parent.children[i];
        if (child.type === 'text' && child.value.includes('**')) {
          const parts = child.value.split('**');
          // If the count of '**' in this text node is odd, there is an unclosed '**' spanning across siblings
          if (parts.length % 2 === 0) {
            const openIdx = child.value.lastIndexOf('**');
            const beforeOpen = child.value.slice(0, openIdx);
            const insideOpen = child.value.slice(openIdx + 2);

            let closeSiblingIdx = -1;
            let closeInSiblingIdx = -1;

            for (let j = i + 1; j < parent.children.length; j++) {
              const sib = parent.children[j];
              if (sib.type === 'text' && sib.value.includes('**')) {
                closeSiblingIdx = j;
                closeInSiblingIdx = sib.value.indexOf('**');
                break;
              }
            }

            if (closeSiblingIdx !== -1) {
              const closeSib = parent.children[closeSiblingIdx];
              const insideClose = closeSib.value.slice(0, closeInSiblingIdx);
              const afterClose = closeSib.value.slice(closeInSiblingIdx + 2);

              const strongChildren = [];
              if (insideOpen) strongChildren.push({ type: 'text', value: insideOpen });
              for (let k = i + 1; k < closeSiblingIdx; k++) {
                strongChildren.push(parent.children[k]);
              }
              if (insideClose) strongChildren.push({ type: 'text', value: insideClose });

              const strongNode = {
                type: 'strong',
                children: strongChildren,
              };

              const replacement = [];
              if (beforeOpen) replacement.push({ type: 'text', value: beforeOpen });
              replacement.push(strongNode);
              if (afterClose) replacement.push({ type: 'text', value: afterClose });

              parent.children.splice(i, closeSiblingIdx - i + 1, ...replacement);
              continue; // Re-evaluate at index i
            }
          }
        }
        i++;
      }
    });

    // Pass 2: Intra-text **...** pairing
    // Handles remaining unparsed bold in single text nodes touching punctuation or Korean particles.
    visit(tree, 'text', (node, index, parent) => {
      if (!node.value || !node.value.includes('**')) return;

      const regex = /\*\*([^*\n]+?)\*\*/g;
      if (!regex.test(node.value)) return;

      regex.lastIndex = 0;
      const newChildren = [];
      let lastIndex = 0;
      let match;

      while ((match = regex.exec(node.value)) !== null) {
        if (match.index > lastIndex) {
          newChildren.push({
            type: 'text',
            value: node.value.slice(lastIndex, match.index),
          });
        }
        newChildren.push({
          type: 'strong',
          children: [{ type: 'text', value: match[1] }],
        });
        lastIndex = match.index + match[0].length;
      }

      if (lastIndex < node.value.length) {
        newChildren.push({
          type: 'text',
          value: node.value.slice(lastIndex),
        });
      }

      if (parent && typeof index === 'number') {
        parent.children.splice(index, 1, ...newChildren);
        return index + newChildren.length;
      }
    });
  };
}
