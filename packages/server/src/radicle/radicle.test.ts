import { describe, it } from 'vitest'

describe('RadicleManager', () => {
  describe('CLI detection', () => {
    it.todo('works when rad CLI is available')
    it.todo('gracefully degrades with clear error when rad is not available')
  })

  describe('initRepo', () => {
    it.todo('initializes a new Radicle repo via rad init')
    it.todo('passes name and description options')
    it.todo('returns RadicleRepoInfo')
    it.todo('emits radicle.repo.init event')
  })

  describe('listRepos', () => {
    it.todo('lists all Radicle repos')
    it.todo('returns array of RadicleRepoInfo')
  })

  describe('push', () => {
    it.todo('pushes to Radicle via rad push')
    it.todo('emits radicle.repo.pushed event')
  })

  describe('pull', () => {
    it.todo('pulls from Radicle via rad pull')
    it.todo('emits radicle.repo.pulled event')
  })

  describe('clone', () => {
    it.todo('clones a Radicle repo via rad clone')
    it.todo('emits radicle.repo.cloned event')
  })

  describe('seed/unseed', () => {
    it.todo('seeds a repo via rad seed')
    it.todo('unseeds a repo via rad unseed')
  })

  describe('identity management', () => {
    it.todo('gets current identity')
    it.todo('returns undefined when no identity exists')
    it.todo('creates a new identity with alias')
    it.todo('sets default identity for signing')
  })

  describe('peer discovery', () => {
    it.todo('lists known peers')
    it.todo('connects to a peer by Node ID')
    it.todo('connects to a peer with optional address')
    it.todo('emits radicle.peer.connected event')
  })

  describe('repo dashboard', () => {
    it.todo('shows peers connected to a repo')
    it.todo('shows replication status')
    it.todo('shows seed nodes')
    it.todo('shows last sync time')
  })

  describe('getStatus', () => {
    it.todo('returns running state, identity, and peer count')
    it.todo('returns running: false when node is not running')
  })

  describe('bus events', () => {
    it.todo('emits radicle.repo.init on init')
    it.todo('emits radicle.repo.pushed on push')
    it.todo('emits radicle.repo.pulled on pull')
    it.todo('emits radicle.repo.cloned on clone')
    it.todo('emits radicle.peer.connected on peer connect')
    it.todo('emits radicle.peer.disconnected on peer disconnect')
  })
})
