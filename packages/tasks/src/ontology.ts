// Forge ontology — the `sovereign-forge` AD4M perspective.
//
// One namespace (`forge://`), four SHACL subject classes, registered when the
// perspective is first opened (ad4m-perspective.ts):
//
//   Task         task://<uuid>        rdf://type forge://Task
//   WorkStream   (a Task)             rdf://type forge://WorkStream, in addition
//   RelatedEdge  forge-edge://<uuid>  rdf://type forge://RelatedEdge
//   ForgeView    forge-view://<uuid>  rdf://type forge://ForgeView
//
// Subtasks are one link per pair, parent → child: `forge://subtask`.
// Scalar values are AD4M string literals; provider and filters are JSON text
// in a string literal.

export const FORGE_PERSPECTIVE_NAME = 'sovereign-forge'

export const RDF_TYPE = 'rdf://type'

export const T = {
  Task: 'forge://Task',
  WorkStream: 'forge://WorkStream',
  RelatedEdge: 'forge://RelatedEdge',
  ForgeView: 'forge://ForgeView'
} as const

export const P = {
  name: 'forge://name',
  state: 'forge://state',
  transientState: 'forge://transientState',
  description: 'forge://description',
  tag: 'forge://tag',
  createdAt: 'forge://createdAt',
  updatedAt: 'forge://updatedAt',
  threadId: 'forge://threadId',
  membrane: 'forge://membrane',
  providerKind: 'forge://providerKind',
  providerKey: 'forge://providerKey',
  provider: 'forge://provider',
  subtask: 'forge://subtask',
  // RelatedEdge
  from: 'forge://from',
  to: 'forge://to',
  reason: 'forge://reason',
  confidence: 'forge://confidence',
  source: 'forge://source',
  // ForgeView
  title: 'forge://title',
  repo: 'forge://repo',
  filters: 'forge://filters',
  height: 'forge://height'
} as const

/** Single-valued string literal property. */
function scalar(name: string, pathIri: string, required = false) {
  return {
    path: pathIri,
    name,
    datatype: 'xsd://string',
    ...(required ? { min_count: 1 } : {}),
    max_count: 1,
    writable: true,
    setter: [{ action: 'setSingleTarget', source: 'this', predicate: pathIri, target: 'value' }]
  }
}

/** Multi-valued property (literals or IRIs). */
function collection(name: string, pathIri: string, nodeKind?: 'IRI') {
  return {
    path: pathIri,
    name,
    ...(nodeKind ? { node_kind: nodeKind } : { datatype: 'xsd://string' }),
    collection: true,
    adder: [{ action: 'addLink', source: 'this', predicate: pathIri, target: 'value' }],
    remover: [{ action: 'removeLink', source: 'this', predicate: pathIri, target: 'value' }]
  }
}

function typed(targetClass: string) {
  return {
    target_class: targetClass,
    constructor_actions: [{ action: 'addLink', source: 'this', predicate: RDF_TYPE, target: targetClass }],
    destructor_actions: [{ action: 'removeLink', source: 'this', predicate: RDF_TYPE, target: targetClass }]
  }
}

const TASK_PROPERTIES = [
  scalar('name', P.name, true),
  scalar('state', P.state, true),
  scalar('transientState', P.transientState),
  scalar('description', P.description),
  collection('tags', P.tag),
  scalar('createdAt', P.createdAt, true),
  scalar('updatedAt', P.updatedAt),
  scalar('threadId', P.threadId),
  scalar('membrane', P.membrane),
  scalar('providerKind', P.providerKind),
  scalar('providerKey', P.providerKey),
  scalar('provider', P.provider),
  collection('subtasks', P.subtask, 'IRI')
]

export const FORGE_SHACL_CLASSES: Record<string, object> = {
  Task: { ...typed(T.Task), properties: TASK_PROPERTIES },
  WorkStream: { ...typed(T.WorkStream), properties: TASK_PROPERTIES },
  RelatedEdge: {
    ...typed(T.RelatedEdge),
    properties: [
      scalar('from', P.from, true),
      scalar('to', P.to, true),
      scalar('reason', P.reason),
      scalar('confidence', P.confidence),
      scalar('source', P.source, true),
      scalar('membrane', P.membrane),
      scalar('createdAt', P.createdAt, true)
    ]
  },
  ForgeView: {
    ...typed(T.ForgeView),
    properties: [
      scalar('membrane', P.membrane, true),
      scalar('title', P.title, true),
      collection('repos', P.repo),
      scalar('filters', P.filters),
      scalar('height', P.height)
    ]
  }
}
