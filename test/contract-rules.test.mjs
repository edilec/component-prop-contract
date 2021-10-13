/**
 * The shape rules for the contract document, each pinned on its own.
 *
 * `test/severity-outcomes.test.mjs` proves every rule id fires with the exit
 * code its severity implies, but one rule id covers several distinct
 * decisions: `member-invalid` fires for a missing name, a non-boolean
 * `required` and an unusable `type` alike. A scenario exercising one of those
 * leaves the others undefended -- a mutation run on the sibling tool found
 * exactly that hole -- so each decision gets its own case here, and each
 * asserts the CONSEQUENCE rather than merely that a finding appeared.
 */

import assert from 'node:assert/strict'
import { after, describe, test } from 'node:test'

import {
  BUTTON_SOURCE, componentEntry, contractDocument, makeCase, removeRoot, reportFor,
} from './support.mjs'

const roots = []
async function caseRoot(contract, source) {
  const root = await makeCase(contract, source)
  roots.push(root)
  return root
}
after(async () => { await Promise.all(roots.map(removeRoot)) })

function oneProp(prop) {
  return contractDocument({ components: [componentEntry({ props: [prop], events: [] })] })
}

describe('"required" is mandatory in the direct spelling', () => {
  for (const value of [undefined, 'yes', 0, null, 1, []]) {
    test(`required: ${JSON.stringify(value)} is refused, not read as optional`, async () => {
      const prop = { name: 'label', type: 'string' }
      if (value !== undefined) prop.required = value
      const root = await caseRoot(oneProp(prop), BUTTON_SOURCE)

      const { code, report } = await reportFor(root)
      const finding = report.findings.find(
        (entry) => entry.ruleId === 'member-invalid' && entry.location.pointer === '/components/0/props/0/required',
      )
      assert.ok(finding, 'an absent or non-boolean required flag must be reported')
      assert.match(finding.message, /an absent flag is not "optional"/)

      // The consequence: the member is refused outright, so the whole
      // component is not compared and nothing about it is claimed.
      assert.equal(report.summary.components, 0)
      assert.equal(report.summary.checked, 0)
      assert.equal(code, 1)
    })
  }

  test('both real booleans are accepted and change the outcome in opposite directions', async () => {
    // A guard that refuses everything passes every test above while making the
    // tool useless.
    const optional = await caseRoot(oneProp({ name: 'label', type: 'string', required: false }), BUTTON_SOURCE)
    const tightened = await reportFor(optional)
    assert.equal(tightened.code, 1)
    assert.ok(tightened.report.findings.some((finding) => finding.ruleId === 'prop-now-required'))

    const required = await caseRoot(oneProp({ name: 'label', type: 'string', required: true }), BUTTON_SOURCE)
    const green = await reportFor(required)
    assert.equal(green.code, 0)
    assert.equal(green.report.summary.membersMatched, 1)
  })

  test('the reverse direction is compatible and reported at info', async () => {
    const root = await caseRoot(
      oneProp({ name: 'variant', type: "'primary' | 'secondary'", required: true }),
      BUTTON_SOURCE,
    )
    const { code, report } = await reportFor(root)
    assert.equal(code, 0, 'a required member the source made optional breaks no caller')
    const finding = report.findings.find((entry) => entry.ruleId === 'prop-now-optional')
    assert.ok(finding)
    assert.equal(finding.severity, 'info')
    assert.equal(report.summary.madeOptional, 1)
  })
})

describe('"required" in the argTypes spelling', () => {
  test('a non-boolean is refused rather than read as "no"', async () => {
    const root = await caseRoot(contractDocument({
      components: [componentEntry({
        props: undefined,
        events: undefined,
        argTypes: { label: { type: { name: 'string', required: 'yes' } } },
      })],
    }), BUTTON_SOURCE)
    const { code, report } = await reportFor(root)
    const finding = report.findings.find((entry) => entry.ruleId === 'member-invalid')
    assert.ok(finding)
    assert.match(finding.message, /neither true nor false is refused rather than read as "no"/)
    assert.equal(report.summary.components, 0)
    assert.equal(code, 1)
  })

  test('omitting it means not required, which is what a story export means by omitting it', async () => {
    const root = await caseRoot(contractDocument({
      components: [componentEntry({
        props: undefined,
        events: undefined,
        argTypes: { variant: { type: { name: 'enum', value: ['primary', 'secondary'] } } },
      })],
    }), BUTTON_SOURCE)
    const { code, report } = await reportFor(root)
    assert.equal(code, 0)
    assert.equal(report.summary.membersMatched, 1)
    assert.equal(report.summary.madeRequired, 0)
  })

  test('each argTypes kind compares the way the rule document says it does', async () => {
    const root = await caseRoot(contractDocument({
      components: [componentEntry({
        props: undefined,
        events: undefined,
        argTypes: {
          label: { type: { name: 'string', required: true } },
          variant: { type: { name: 'enum', value: ['primary', 'secondary'] } },
          onClick: { type: { name: 'function' } },
        },
      })],
    }), BUTTON_SOURCE)
    const { code, report } = await reportFor(root)
    assert.equal(code, 0)
    assert.equal(report.summary.typesMatched, 3)
    assert.equal(report.summary.typesUnconstrained, 0)
  })

  test('a kind that carries no information places no requirement, and says so', async () => {
    const root = await caseRoot(contractDocument({
      components: [componentEntry({
        props: undefined,
        events: undefined,
        argTypes: { label: { type: { name: 'object', required: true } } },
      })],
    }), BUTTON_SOURCE)
    const { code, report } = await reportFor(root)
    assert.equal(code, 0)
    const finding = report.findings.find((entry) => entry.ruleId === 'prop-type-unconstrained')
    assert.ok(finding, 'the absence of a comparison is visible rather than silent')
    assert.equal(report.summary.typesUnconstrained, 1)
  })

  test('a string kind really is compared, and a mismatch fails', async () => {
    const root = await caseRoot(contractDocument({
      components: [componentEntry({
        props: undefined,
        events: undefined,
        argTypes: { variant: { type: { name: 'string' } } },
      })],
    }), BUTTON_SOURCE)
    const { code, report } = await reportFor(root)
    assert.equal(code, 1)
    const finding = report.findings.find((entry) => entry.ruleId === 'prop-type-changed')
    assert.ok(finding)
    assert.match(finding.evidence, /contract: string/)
  })

  test('an enum kind compares as a set, and a renamed value fails', async () => {
    const root = await caseRoot(contractDocument({
      components: [componentEntry({
        props: undefined,
        events: undefined,
        argTypes: { variant: { type: { name: 'enum', value: ['primary', 'subtle'] } } },
      })],
    }), BUTTON_SOURCE)
    const { code, report } = await reportFor(root)
    assert.equal(code, 1)
    assert.ok(report.findings.some((finding) => finding.ruleId === 'prop-type-changed'))
  })

  test('a function kind accepts any callable and refuses anything else', async () => {
    const ok = await caseRoot(contractDocument({
      components: [componentEntry({ props: undefined, events: undefined, argTypes: { onClick: { type: { name: 'function' } } } })],
    }), BUTTON_SOURCE)
    assert.equal((await reportFor(ok)).code, 0)

    const wrong = await caseRoot(contractDocument({
      components: [componentEntry({ props: undefined, events: undefined, argTypes: { label: { type: { name: 'function' } } } })],
    }), BUTTON_SOURCE)
    const { code, report } = await reportFor(wrong)
    assert.equal(code, 1)
    assert.ok(report.findings.some((finding) => finding.ruleId === 'prop-type-changed'))
  })
})

describe('one rule decides what an event is', () => {
  test('an event declared under props is reported rather than silently reclassified', async () => {
    const root = await caseRoot(contractDocument({
      components: [componentEntry({
        props: [{ name: 'onClick', type: '(event: MouseEvent) => void', required: false }],
        events: [],
      })],
    }), BUTTON_SOURCE)
    const { code, report } = await reportFor(root)
    const finding = report.findings.find((entry) => entry.ruleId === 'member-misclassified')
    assert.ok(finding)
    assert.match(finding.suggestion, /Move it to "events"/)
    assert.equal(report.summary.components, 0)
    assert.equal(code, 1)
  })

  test('a prop declared under events is reported too', async () => {
    const root = await caseRoot(contractDocument({
      components: [componentEntry({
        props: [],
        events: [{ name: 'label', type: 'string', required: true }],
      })],
    }), BUTTON_SOURCE)
    const { code, report } = await reportFor(root)
    const finding = report.findings.find((entry) => entry.ruleId === 'member-misclassified')
    assert.ok(finding)
    assert.match(finding.suggestion, /Move it to "props"/)
    assert.equal(code, 1)
  })

  test('the classification decides which rule id a missing member gets', async () => {
    const root = await caseRoot(contractDocument({
      components: [componentEntry({
        props: [{ name: 'gone', type: 'string', required: true }],
        events: [{ name: 'onGone', type: '() => void', required: true }],
      })],
    }), BUTTON_SOURCE)
    const { report } = await reportFor(root)
    assert.ok(report.findings.some((finding) => finding.ruleId === 'prop-missing'))
    assert.ok(report.findings.some((finding) => finding.ruleId === 'event-missing'))
  })
})

describe('optional fields that are present must still be usable', () => {
  const OPTIONALS = [
    { field: 'note', on: 'member', pointer: '/components/0/props/0/note', ruleId: 'member-invalid' },
    { field: 'type', on: 'member', pointer: '/components/0/props/0/type', ruleId: 'member-invalid' },
    { field: 'note', on: 'component', pointer: '/components/0/note', ruleId: 'component-invalid' },
    { field: 'description', on: 'contract', pointer: '/description', ruleId: 'contract-invalid' },
  ]

  for (const optional of OPTIONALS) {
    for (const value of ['', 42, null]) {
      test(`${optional.on} "${optional.field}": ${JSON.stringify(value)} is refused`, async () => {
        const prop = { name: 'label', type: 'string', required: true }
        const component = componentEntry({ props: [prop], events: [] })
        const contract = contractDocument({ components: [component] })
        if (optional.on === 'member') prop[optional.field] = value
        if (optional.on === 'component') component[optional.field] = value
        if (optional.on === 'contract') contract[optional.field] = value

        const root = await caseRoot(contract, BUTTON_SOURCE)
        const { code, report } = await reportFor(root)
        const finding = report.findings.find(
          (entry) => entry.ruleId === optional.ruleId && entry.location.pointer === optional.pointer,
        )
        assert.ok(finding, `${optional.field} was accepted and ignored`)
        assert.equal(code, 1)
      })
    }
  }

  test('omitting "type" is a real answer and places no requirement', async () => {
    const root = await caseRoot(oneProp({ name: 'label', required: true }), BUTTON_SOURCE)
    const { code, report } = await reportFor(root)
    assert.equal(code, 0)
    assert.ok(report.findings.some((finding) => finding.ruleId === 'prop-type-unconstrained'))
  })
})

describe('identity fields', () => {
  test('a duplicate component id refuses the second entry rather than merging it', async () => {
    const root = await caseRoot(contractDocument({
      components: [componentEntry(), componentEntry()],
    }), BUTTON_SOURCE)
    const { code, report } = await reportFor(root)
    const finding = report.findings.find((entry) => entry.ruleId === 'component-id-duplicate')
    assert.ok(finding)
    assert.equal(finding.evidence, 'also declared at /components/0')
    assert.equal(report.summary.components, 1)
    assert.equal(code, 1)
  })

  test('a member declared twice within props is refused', async () => {
    // The direct spelling and the argTypes spelling check this at two
    // different code sites, and a test exercising only one of them leaves the
    // other undefended -- which a mutation run found.
    const root = await caseRoot(contractDocument({
      components: [componentEntry({
        props: [
          { name: 'label', type: 'string', required: true },
          { name: 'label', type: 'number', required: false },
        ],
        events: [],
      })],
    }), BUTTON_SOURCE)
    const { code, report } = await reportFor(root)
    const finding = report.findings.find((entry) => entry.ruleId === 'member-duplicate')
    assert.ok(finding, 'two entries for one member state two requirements and neither is authoritative')
    assert.equal(finding.location.pointer, '/components/0/props/1/name')
    assert.equal(finding.evidence, 'also declared at /components/0/props/0')
    assert.equal(report.summary.components, 0, 'the component is not compared against an ambiguous contract')
    assert.equal(report.summary.checked, 0)
    assert.equal(code, 1)
  })

  test('the same two names, distinct, are both read', async () => {
    // A guard that refuses every second member passes the test above while
    // making the tool useless.
    const root = await caseRoot(contractDocument({
      components: [componentEntry({
        props: [
          { name: 'label', type: 'string', required: true },
          { name: 'variant', type: "'primary' | 'secondary'", required: false },
        ],
        events: [],
      })],
    }), BUTTON_SOURCE)
    const { code, report } = await reportFor(root)
    assert.equal(code, 0)
    assert.equal(report.summary.checked, 2)
    assert.equal(report.summary.membersMatched, 2)
  })

  test('a member declared twice across props and argTypes is refused', async () => {
    const root = await caseRoot(contractDocument({
      components: [componentEntry({
        props: [{ name: 'label', type: 'string', required: true }],
        events: [],
        argTypes: { label: { type: { name: 'string' } } },
      })],
    }), BUTTON_SOURCE)
    const { code, report } = await reportFor(root)
    const finding = report.findings.find((entry) => entry.ruleId === 'member-duplicate')
    assert.ok(finding)
    assert.equal(report.summary.components, 0)
    assert.equal(code, 1)
  })

  test('a contract version that is not major.minor.patch is refused', async () => {
    for (const version of ['2', '2.3', 'v2.3.0', '2.3.0-beta', 4]) {
      const root = await caseRoot(contractDocument({ version }), BUTTON_SOURCE)
      const { code, report } = await reportFor(root)
      assert.ok(
        report.findings.some((finding) => finding.ruleId === 'contract-version-invalid'),
        `version ${JSON.stringify(version)} was accepted`,
      )
      assert.equal(code, 1)
      assert.equal(report.summary.contractVersion, null)
    }
  })

  test('a valid version is recorded in the report', async () => {
    const root = await caseRoot(contractDocument({ version: '12.0.4' }), BUTTON_SOURCE)
    const { code, report } = await reportFor(root)
    assert.equal(code, 0)
    assert.equal(report.summary.contractVersion, '12.0.4')
  })
})
