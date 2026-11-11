import { useEffect, type ReactNode } from "react";

import type { CopyParams } from "../i18n/copy.js";
import { useCopy } from "../i18n/useCopy.js";
import { INFO_PAGES, splitPlaceholders, type Block, type InfoPageName } from "../lib/pages.js";
import { useStore } from "../state/store.js";

interface Props {
  page: InfoPageName;
  /** Show the "Draft, pending review" notice. Only the privacy policy is ever a draft. */
  draft: boolean;
}

/**
 * /privacy or /support: long form reading, signed in or not.
 *
 * Plain links throughout (back to "/", mailto for support), so the page needs nothing from the
 * session or the socket and works as a first navigation. The measure is held near 70 characters
 * and every size is relative, so a phone gets the same column at its own width with nothing to
 * scroll sideways.
 */
export function InfoPage({ page, draft }: Props) {
  const copy = useCopy();
  const supportEmail = useStore((state) => state.supportEmail);
  const outline = INFO_PAGES[page];
  const title = copy.t(outline.title);

  useEffect(() => {
    const before = document.title;
    document.title = `${title} · Translatv`;
    return () => {
      document.title = before;
    };
  }, [title]);

  const line = (key: Parameters<typeof copy.t>[0], params: CopyParams = outline.params): ReactNode =>
    splitPlaceholders(copy.t(key, params)).map((piece, index) =>
      piece.placeholder ? (
        <mark key={index} className="owner-placeholder">
          {piece.text}
        </mark>
      ) : (
        piece.text
      ),
    );

  const block = (item: Block, index: number): ReactNode => {
    if (item.kind === "paragraph") return <p key={index}>{line(item.key)}</p>;
    if (item.kind === "list") {
      return (
        <ul key={index}>
          {item.items.map((key) => (
            <li key={key}>{line(key)}</li>
          ))}
        </ul>
      );
    }
    if (supportEmail) {
      return (
        <p key={index}>
          {line(item.withEmail)} <a href={`mailto:${supportEmail}`}>{supportEmail}</a>
        </p>
      );
    }
    return <p key={index}>{line(item.withoutEmail)}</p>;
  };

  return (
    <main className="doc-page">
      <article className="doc" aria-labelledby="doc-title">
        <p className="doc-nav">
          <a href="/">{copy.t("site.back")}</a>
        </p>
        <h1 id="doc-title">{title}</h1>
        {draft && page === "privacy" && (
          <p className="doc-draft" role="note">
            {copy.t("page.draft")}
          </p>
        )}
        {page === "privacy" && <p className="doc-lead">{line("privacy.intro")}</p>}
        {outline.sections.map((section) => {
          const Heading = section.level === 2 ? "h2" : "h3";
          return (
            <section key={section.heading} className={`doc-section level-${section.level}`}>
              <Heading>{copy.t(section.heading)}</Heading>
              {section.blocks.map(block)}
            </section>
          );
        })}
        <p className="doc-nav doc-foot">
          <a href={page === "privacy" ? "/support" : "/privacy"}>{copy.t(page === "privacy" ? "site.support" : "site.privacy")}</a>
          {" · "}
          <a href="/">{copy.t("site.back")}</a>
        </p>
      </article>
    </main>
  );
}

/**
 * The quiet links to the public pages, for the sign in card and the account strip: privacy,
 * help, and the support address when the server has one (no address, no link, never a dead one).
 */
export function SiteLinks() {
  const copy = useCopy();
  const supportEmail = useStore((state) => state.supportEmail);
  return (
    <nav className="site-links" aria-label={copy.t("site.links")}>
      <a href="/privacy">{copy.t("site.privacy")}</a>
      <a href="/support">{copy.t("site.support")}</a>
      {supportEmail && <a href={`mailto:${supportEmail}`}>{copy.t("site.contact")}</a>}
    </nav>
  );
}
