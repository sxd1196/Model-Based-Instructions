/**
 * Rich text rendering.
 *
 * Renders structured spans to React elements. The mark set is CLOSED — only
 * known tags are ever emitted, so a project file can never inject markup into
 * the app or the exported work instructions.
 */
import type { RichText, TextMark } from '@/domain/schema';

export { richToHtml } from '@/domain/richtext';

const TAGS: Record<TextMark, keyof React.JSX.IntrinsicElements> = {
  bold: 'strong',
  italic: 'em',
  underline: 'u',
  sup: 'sup',
  sub: 'sub',
  code: 'code',
};

/** Render RichText, falling back to plain text when no formatting exists. */
export function RichTextView({
  rich,
  plain,
}: {
  rich?: RichText;
  plain: string;
}) {
  if (!rich?.length) return <>{plain}</>;

  return (
    <>
      {rich.map((para, pi) => (
        <div key={pi} className="rt-para">
          {para.length === 0 ? (
            <br />
          ) : (
            para.map((span, si) => {
              let node: React.ReactNode = span.text;
              // Nest from the inside out so marks compose predictably.
              // Cast: TAGS only ever yields simple text-level tags, but TS
              // cannot narrow a union of intrinsic elements to a common
              // children signature.
              for (const mark of span.marks) {
                const Tag = TAGS[mark] as 'span';
                node = <Tag key={mark}>{node}</Tag>;
              }
              return (
                <span key={si} style={span.color ? { color: span.color } : undefined}>
                  {node}
                </span>
              );
            })
          )}
        </div>
      ))}
    </>
  );
}
