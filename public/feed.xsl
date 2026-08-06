<?xml version="1.0" encoding="UTF-8"?>
<!--
  What a person sees when they click an RSS link.

  A browser handed raw RSS shows a wall of angle brackets, or offers to download
  it, and the reasonable conclusion is that something is broken. This stylesheet
  is applied by the browser to render the very same document as a readable page,
  while feed readers ignore it and parse the XML underneath. One URL, both
  audiences, no content negotiation and no second endpoint to keep in step.

  The page has to explain itself too: someone arriving here probably clicked
  "RSS" without knowing what that is, so it says what the URL is for rather than
  assuming.
-->
<xsl:stylesheet version="1.0"
                xmlns:xsl="http://www.w3.org/1999/XSL/Transform"
                xmlns:atom="http://www.w3.org/2005/Atom"
                xmlns:media="http://search.yahoo.com/mrss/"
                xmlns:pw="https://github.com/SakusenCoffee/ccnotif/ns">

  <xsl:output method="html" version="1.0" encoding="UTF-8" indent="yes"/>

  <xsl:template match="/rss">
    <html lang="en">
      <head>
        <meta charset="utf-8"/>
        <meta name="viewport" content="width=device-width, initial-scale=1"/>
        <title><xsl:value-of select="channel/title"/></title>
        <style>
          :root {
            color-scheme: dark light;
            --bg: #0f1115;
            --card: #171a21;
            --line: #262b36;
            --text: #e8eaef;
            --muted: #99a1b3;
            --accent: #6ea8fe;
            --good: #4ade80;
            --new: #fbbf24;
          }
          @media (prefers-color-scheme: light) {
            :root {
              --bg: #f6f7f9; --card: #ffffff; --line: #e3e6ec;
              --text: #14161a; --muted: #5c6474; --accent: #1c64f2;
            }
          }
          * { box-sizing: border-box; }
          body {
            margin: 0; padding: 2rem 1rem 4rem;
            background: var(--bg); color: var(--text);
            font: 16px/1.55 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
          }
          .wrap { max-width: 780px; margin: 0 auto; }
          h1 { font-size: 1.6rem; margin: 0 0 .35rem; letter-spacing: -.01em; }
          .tagline { color: var(--muted); margin: 0 0 1.5rem; }
          .explain {
            background: var(--card); border: 1px solid var(--line);
            border-radius: 12px; padding: 1rem 1.1rem; margin-bottom: 1.75rem;
          }
          .explain h2 { font-size: .95rem; margin: 0 0 .4rem; }
          .explain p { margin: 0 0 .6rem; color: var(--muted); font-size: .92rem; }
          .explain p:last-child { margin-bottom: 0; }
          .url {
            display: block; width: 100%; margin-top: .5rem; padding: .55rem .7rem;
            background: var(--bg); border: 1px solid var(--line); border-radius: 8px;
            font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
            font-size: .85rem; color: var(--text); word-break: break-all;
          }
          .count { color: var(--muted); font-size: .85rem; margin-bottom: .75rem; }
          ul.items { list-style: none; margin: 0; padding: 0; display: grid; gap: .85rem; }
          li.item {
            background: var(--card); border: 1px solid var(--line);
            border-radius: 12px; padding: .9rem 1rem;
            display: grid; grid-template-columns: 72px 1fr; gap: .9rem; align-items: start;
          }
          li.item.noimg { grid-template-columns: 1fr; }
          .thumb {
            width: 72px; height: 72px; object-fit: contain;
            background: #fff; border-radius: 8px;
          }
          .badge {
            display: inline-block; font-size: .72rem; font-weight: 600;
            padding: .15rem .5rem; border-radius: 999px; margin-bottom: .35rem;
            border: 1px solid var(--line); color: var(--muted);
          }
          .badge.restock { color: var(--good); border-color: var(--good); }
          .badge.new { color: var(--new); border-color: var(--new); }
          .title { font-weight: 600; margin: 0 0 .2rem; }
          .title a { color: var(--text); text-decoration: none; }
          .title a:hover { color: var(--accent); text-decoration: underline; }
          .meta { color: var(--muted); font-size: .87rem; }
          .price { font-variant-numeric: tabular-nums; }
          .when { color: var(--muted); font-size: .8rem; margin-top: .3rem; }
          .empty {
            background: var(--card); border: 1px dashed var(--line);
            border-radius: 12px; padding: 2rem 1rem; text-align: center; color: var(--muted);
          }
          footer { margin-top: 2.5rem; color: var(--muted); font-size: .82rem; }
          footer a { color: var(--accent); }
          @media (max-width: 480px) {
            li.item { grid-template-columns: 56px 1fr; }
            .thumb { width: 56px; height: 56px; }
          }
        </style>
      </head>
      <body>
        <div class="wrap">
          <h1><xsl:value-of select="channel/title"/></h1>
          <p class="tagline"><xsl:value-of select="channel/description"/></p>

          <div class="explain">
            <h2>This page is a feed</h2>
            <p>
              You are looking at it in a browser, so it has been made readable. Paste
              the address below into a feed reader and it will tell you the moment
              anything new shows up here — no checking back, no account.
            </p>
            <code class="url"><xsl:value-of select="channel/atom:link/@href"/></code>
          </div>

          <xsl:choose>
            <xsl:when test="channel/item">
              <p class="count">
                <xsl:value-of select="count(channel/item)"/>
                <xsl:text> recent </xsl:text>
                <xsl:if test="count(channel/item) = 1">update</xsl:if>
                <xsl:if test="count(channel/item) != 1">updates</xsl:if>
              </p>
              <ul class="items">
                <xsl:apply-templates select="channel/item"/>
              </ul>
            </xsl:when>
            <xsl:otherwise>
              <div class="empty">
                Nothing yet. Once a pre-order here flips to buyable, it appears in
                this feed within a minute.
              </div>
            </xsl:otherwise>
          </xsl:choose>

          <footer>
            <p>
              <a href="/">Open <xsl:value-of select="channel/title"/></a>
            </p>
          </footer>
        </div>
      </body>
    </html>
  </xsl:template>

  <xsl:template match="item">
    <li>
      <xsl:attribute name="class">
        <xsl:text>item</xsl:text>
        <xsl:if test="not(media:thumbnail/@url)"> noimg</xsl:if>
      </xsl:attribute>

      <xsl:if test="media:thumbnail/@url">
        <img class="thumb" loading="lazy" alt="">
          <xsl:attribute name="src"><xsl:value-of select="media:thumbnail/@url"/></xsl:attribute>
        </img>
      </xsl:if>

      <div>
        <span>
          <xsl:attribute name="class">badge <xsl:value-of select="pw:kind"/></xsl:attribute>
          <xsl:value-of select="pw:label"/>
        </span>

        <p class="title">
          <a target="_blank" rel="noopener">
            <xsl:attribute name="href"><xsl:value-of select="link"/></xsl:attribute>
            <!-- pw:product is the bare product name; `title` repeats the label. -->
            <xsl:choose>
              <xsl:when test="pw:product"><xsl:value-of select="pw:product"/></xsl:when>
              <xsl:otherwise><xsl:value-of select="title"/></xsl:otherwise>
            </xsl:choose>
          </a>
        </p>

        <div class="meta">
          <span class="price"><xsl:value-of select="pw:price"/></span>
          <xsl:if test="pw:store">
            <xsl:text> · </xsl:text><xsl:value-of select="pw:store"/>
          </xsl:if>
          <xsl:if test="pw:vendor">
            <xsl:text> · </xsl:text><xsl:value-of select="pw:vendor"/>
          </xsl:if>
        </div>

        <div class="when"><xsl:value-of select="pubDate"/></div>
      </div>
    </li>
  </xsl:template>
</xsl:stylesheet>
