import test from 'node:test';
import assert from 'node:assert/strict';
import { mergeServerRelatedLinks } from '../src/core/relationship-server-links.ts';

function graph(links = []) {
  return {
    profileSignature: 'sig',
    createdAt: '2026-11-20T00:00:00.000Z',
    nodes: [
      { id: 'movie:1', label: 'A', title: 'A', mediaType: 'movie', kind: 'source', personalScore: 70 },
      { id: 'movie:2', label: 'B', title: 'B', mediaType: 'movie', kind: 'candidate', personalScore: 60 },
      { id: 'tv:3', label: 'C', title: 'C', mediaType: 'tv', kind: 'candidate', personalScore: 50 },
    ],
    links,
  };
}

test('sunucu ilişkisi grafikte olmayan hedefi eklemez', () => {
  const merged = mergeServerRelatedLinks(graph(), 'movie:1', [
    { targetKey: 'movie:99', cosineSimilarity: 0.9 },
  ]);
  assert.equal(merged.links.length, 0);
});

test('sunucu ilişkisi yeni anlamsal bağ ve kanıt üretir', () => {
  const merged = mergeServerRelatedLinks(graph(), 'movie:1', [
    {
      targetKey: 'movie:2',
      cosineSimilarity: 0.82,
      atmosphereSimilarity: 0.7,
      sharedConcepts: ['kayıp', 'hafıza'],
      confidence: 0.9,
    },
  ]);
  assert.equal(merged.links.length, 1);
  const link = merged.links[0];
  assert.equal(link.type, 'semantic');
  assert.equal(link.score, 82);
  assert.ok(link.evidence[0].includes('İçerik zekâsı'));
  assert.ok(link.evidence.some((line) => line.includes('hafıza')));
  assert.equal(link.source, 'movie:1');
});

test('mevcut bağ silinmez; kanıt ve tür birleşir', () => {
  const existing = {
    source: 'movie:1',
    target: 'movie:2',
    type: 'universe',
    alsoRelatedBy: ['universe'],
    score: 70,
    confidence: 0.6,
    evidence: ['Aynı evren'],
    distance: 110,
  };
  const merged = mergeServerRelatedLinks(graph([existing]), 'movie:1', [
    { targetKey: 'movie:2', cosineSimilarity: 0.75 },
  ]);
  assert.equal(merged.links.length, 1);
  const link = merged.links[0];
  assert.equal(link.type, 'universe');
  assert.ok(link.alsoRelatedBy.includes('semantic'));
  assert.ok(link.evidence.includes('Aynı evren'));
  assert.ok(link.evidence.some((line) => line.startsWith('İçerik zekâsı')));
  assert.ok(link.confidence >= 0.75);
});

test('aynı sunucu kanıtı ikinci kez eklenmez', () => {
  const first = mergeServerRelatedLinks(graph(), 'movie:1', [
    { targetKey: 'movie:2', cosineSimilarity: 0.8 },
  ]);
  const second = mergeServerRelatedLinks(first, 'movie:1', [
    { targetKey: 'movie:2', cosineSimilarity: 0.8 },
  ]);
  assert.equal(second, first);
});
