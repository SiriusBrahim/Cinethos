/**
 * F5.2-01 — React öğe ağacı inceleme yardımcıları.
 *
 * Bileşenler `react-dom/server` ile gerçekten render edilir; etkileşim
 * doğrulaması için sunucu render'ında çalışmayan `onClick` gibi işleyiciler
 * öğe ağacından bulunup doğrudan çağrılır. Kaynak kod metni okunmaz.
 */

import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

export function renderMarkup(element) {
  return renderToStaticMarkup(element);
}

/** Gerçek render çıktısındaki metni (HTML etiketlerinden arındırılmış) döndürür. */
export function renderText(element) {
  return renderToStaticMarkup(element)
    .replace(/<[^>]*>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ')
    .trim();
}

export function walkElements(node, visit) {
  if (node == null || typeof node === 'boolean') return;
  if (Array.isArray(node)) {
    for (const child of node) walkElements(child, visit);
    return;
  }
  if (typeof node !== 'object') return;
  if (React.isValidElement(node)) {
    visit(node);
    walkElements(node.props?.children, visit);
    return;
  }
}

export function elementText(element) {
  let text = '';
  walkElements(element, (node) => {
    const children = node.props?.children;
    if (typeof children === 'string' || typeof children === 'number') {
      text += `${children} `;
    }
  });
  return text.replace(/\s+/g, ' ').trim();
}

export function findAll(element, predicate) {
  const found = [];
  walkElements(element, (node) => {
    if (predicate(node)) found.push(node);
  });
  return found;
}

export function findButtonByText(element, text) {
  const buttons = findAll(element, (node) => node.type === 'button');
  const match = buttons.find((button) => elementText(button).includes(text));
  if (!match) {
    throw new Error(
      `Metni "${text}" olan düğme bulunamadı. Bulunanlar: ${buttons
        .map((b) => elementText(b))
        .join(' | ')}`
    );
  }
  return match;
}
