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
  ARGTYPE_COMPARED_TYPE_NAMES, ARGTYPE_TYPE_NAMES, describeMatcher, matcherFromArgType, matchesType,
} from '../src/index.mjs'
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

/**
 * A typo in a value must not be quieter than a typo in a key.
 *
 * `{"type": {"nmae": "string"}}` was refused at exit 1 from the first release.
 * `{"type": {"name": "strnig"}}` fell through to "no requirement at all" and
 * the run went green -- the same one-character mistake, one character to the
 * right, turning a real failure into a pass. So the type names are a closed
 * vocabulary, and the ones that carry no comparable requirement are IN it.
 */
describe('an argTypes type name is a vocabulary, not free text', () => {
  const REAL_MISMATCH = contractDocument({
    components: [componentEntry({
      props: undefined,
      events: undefined,
      argTypes: { label: { type: { name: 'number', required: true } } },
    })],
  })

  test('the correctly spelled name states a real requirement, and it fails', async () => {
    const { code, report } = await reportFor(await caseRoot(REAL_MISMATCH, BUTTON_SOURCE))
    assert.equal(code, 1, 'label is declared string in the source and number in the contract')
    assert.ok(report.findings.some((finding) => finding.ruleId === 'prop-type-changed'))
  })

  test('a one-character typo in that name is refused, not read as "no requirement"', async () => {
    const { code, report } = await reportFor(await caseRoot(contractDocument({
      components: [componentEntry({
        props: undefined,
        events: undefined,
        argTypes: { label: { type: { name: 'nubmer', required: true } } },
      })],
    }), BUTTON_SOURCE))
    assert.equal(code, 1, 'a typo must not turn a real failure into a green run')
    const finding = report.findings.find((entry) => entry.ruleId === 'member-invalid')
    assert.ok(finding)
    assert.equal(finding.location.pointer, '/components/0/argTypes/label/type/name')
    assert.match(finding.message, /does not know/)
    assert.equal(report.summary.components, 0, 'and the component is not compared on a contract nobody could read')
  })

  for (const value of [null, 7, true, [], { toString: {} }]) {
    test(`a type name that is ${JSON.stringify(value) ?? 'null'} is refused like any other unknown name`, async () => {
      const { code, report } = await reportFor(await caseRoot(contractDocument({
        components: [componentEntry({
          props: undefined,
          events: undefined,
          argTypes: { label: { type: { name: value, required: true } } },
        })],
      }), BUTTON_SOURCE))
      assert.equal(code, 1)
      assert.ok(report.findings.some((finding) => finding.ruleId === 'member-invalid'))
    })
  }

  test('a type name that carries no comparable requirement is still a known name', async () => {
    for (const name of ['array', 'intersection', 'object', 'other', 'union']) {
      const { code, report } = await reportFor(await caseRoot(contractDocument({
        components: [componentEntry({
          props: undefined,
          events: undefined,
          argTypes: { label: { type: { name, required: true } } },
        })],
      }), BUTTON_SOURCE))
      assert.equal(code, 0, `${name} is a name a story export really produces`)
      assert.equal(report.summary.typesUnconstrained, 1)
    }
  })
})

describe('an argTypes enum states its values or states nothing usable', () => {
  async function enumCase(value) {
    return reportFor(await caseRoot(contractDocument({
      components: [componentEntry({
        props: undefined,
        events: undefined,
        argTypes: { variant: { type: { name: 'enum', value } } },
      })],
    }), BUTTON_SOURCE))
  }

  test('a list of strings is the requirement, and it is compared', async () => {
    const { code } = await enumCase(['primary', 'secondary'])
    assert.equal(code, 0)
  })

  test('a list carrying a non-string is refused, not degraded to no requirement', async () => {
    const { code, report } = await enumCase(['primary', 7])
    assert.equal(code, 1)
    const finding = report.findings.find((entry) => entry.ruleId === 'member-invalid')
    assert.ok(finding)
    assert.equal(finding.location.pointer, '/components/0/argTypes/variant/type/value/1')
    assert.equal(report.summary.typesUnconstrained, 0, 'the requirement did not quietly become none')
  })

  test('a value that renders as nothing is refused rather than compared as a blank literal', async () => {
    const invisible = `${String.fromCharCode(0x01)}${String.fromCharCode(0x85)}${String.fromCharCode(0x200e)}`
    const { code, report } = await enumCase([invisible, 'secondary'])
    assert.equal(code, 1)
    assert.ok(report.findings.some((finding) => finding.ruleId === 'member-invalid'))
    for (const finding of report.findings) {
      assert.equal(/'\s*'/.test(finding.evidence ?? ''), false, 'no requirement is rendered as a blank quoted literal')
    }
  })

  test('an enum with no values, or with no "value" at all, is refused', async () => {
    for (const value of [[], undefined, 'primary', null]) {
      const { code, report } = await enumCase(value)
      assert.equal(code, 1, `value ${JSON.stringify(value) ?? 'undefined'} was accepted`)
      assert.ok(report.findings.some((finding) => finding.ruleId === 'member-invalid'))
    }
  })
})

describe('the free-text fields of an argTypes entry', () => {
  for (const field of ['description', 'name']) {
    test(`"${field}" present but unusable is refused, like every other optional field`, async () => {
      for (const value of [{ toString: {} }, `${String.fromCharCode(0x200e)}`, '', 7, null]) {
        const { code, report } = await reportFor(await caseRoot(contractDocument({
          components: [componentEntry({
            props: undefined,
            events: undefined,
            argTypes: { label: { [field]: value, type: { name: 'string', required: true } } },
          })],
        }), BUTTON_SOURCE))
        assert.equal(code, 1, `${field} = ${JSON.stringify(value) ?? 'undefined'} was accepted`)
        const finding = report.findings.find((entry) => entry.ruleId === 'member-invalid')
        assert.ok(finding)
        assert.equal(finding.location.pointer, `/components/0/argTypes/label/${field}`)
      }
    })

    test(`"${field}" as ordinary text is accepted, so the guard is not refusing everything`, async () => {
      const { code } = await reportFor(await caseRoot(contractDocument({
        components: [componentEntry({
          props: undefined,
          events: undefined,
          argTypes: { label: { [field]: 'the visible label', type: { name: 'string', required: true } } },
        })],
      }), BUTTON_SOURCE))
      assert.equal(code, 0)
    })
  }
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

  /**
   * The "no whitespace" half of `isUsableName` is stated in three user-facing
   * error messages and had no test. It is also the only thing refusing a name
   * that carries an embedded control character: `isUsableText` would SANITISE
   * such a name to a non-empty string rather than refuse it, so the report
   * would name a member the source cannot possibly declare.
   */
  test('a member name carrying whitespace is refused, on either side of the comparison', async () => {
    for (const name of ['a b', 'a\tb', `a${String.fromCharCode(0x0a)}b`, ' leading', 'trailing ']) {
      const { code, report } = await reportFor(await caseRoot(oneProp({ name, type: 'string', required: true }), BUTTON_SOURCE))
      assert.equal(code, 1, `${JSON.stringify(name)} was accepted as a member name`)
      const finding = report.findings.find((entry) => entry.ruleId === 'member-invalid')
      assert.ok(finding)
      assert.match(finding.message, /no whitespace/)
    }
  })

  test('a component id carrying whitespace is refused too', async () => {
    const { code, report } = await reportFor(await caseRoot(
      contractDocument({ components: [componentEntry({ id: 'My Button' })] }),
      BUTTON_SOURCE,
    ))
    assert.equal(code, 1)
    assert.ok(report.findings.some((finding) => finding.ruleId === 'component-invalid'))
    assert.equal(report.summary.components, 0)
  })

  test('and a hyphenated or camel-cased name is accepted, so the guard is not refusing everything', async () => {
    const { code } = await reportFor(await caseRoot(
      contractDocument({
        components: [componentEntry({
          props: [{ name: 'label', type: 'string', required: true }],
          events: [],
        })],
      }),
      "export interface ButtonProps {\n  label: string;\n  'aria-label'?: string;\n  dataTestId?: string;\n}\n",
    ))
    assert.equal(code, 0)
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

/**
 * The matcher, asked directly.
 *
 * Everything above drives the CLI, which now refuses a malformed `argTypes`
 * type before this function sees it. That is the right place for the refusal
 * -- only the reader of the document can point a finding at the field -- but
 * it leaves `matcherFromArgType` total by design, and "total" is a claim about
 * what it returns for input the CLI no longer hands it. So it is asked here,
 * at its own entry point, rather than left to a caller that has stopped
 * reaching its guards.
 */
describe('matcherFromArgType is total, whatever it is handed', () => {
  test('a kind that compares, compares', () => {
    for (const name of ['boolean', 'number', 'string', 'symbol']) {
      assert.deepEqual({ ...matcherFromArgType({ name }) }, { kind: 'exact', text: name, source: name })
    }
    assert.equal(matcherFromArgType({ name: 'function' }).kind, 'callable')
    assert.deepEqual([...matcherFromArgType({ name: 'enum', value: ['b', 'a'] }).values], ['b', 'a'])
  })

  test('an enum whose values are not all strings states no requirement rather than a partial one', () => {
    // A partial requirement is the dangerous answer: comparing 'a' | 'b'
    // against a one-element expected set reports a change that is really a
    // malformed contract. `none` is honest; the CLI refuses the document.
    assert.equal(matcherFromArgType({ name: 'enum', value: ['a', 7] }).kind, 'none')
    assert.equal(matcherFromArgType({ name: 'enum', value: [] }).kind, 'none')
    assert.equal(matcherFromArgType({ name: 'enum' }).kind, 'none')
  })

  test('a type that is not an object, or names nothing known, states no requirement', () => {
    for (const type of [null, 7, 'string', [], {}, { name: 'strnig' }, { name: 7 }]) {
      assert.equal(matcherFromArgType(type).kind, 'none', `${JSON.stringify(type) ?? 'null'} produced a requirement`)
    }
  })

  test('a "none" matcher compares nothing, and says compared: false', () => {
    assert.deepEqual(matchesType({ kind: 'none' }, 'string'), { compared: false, ok: true, expected: '' })
    assert.equal(describeMatcher({ kind: 'none' }), 'no type')
  })

  test('the compared vocabulary is a subset of the accepted one', () => {
    for (const name of ARGTYPE_COMPARED_TYPE_NAMES) {
      assert.ok(ARGTYPE_TYPE_NAMES.includes(name), `${name} is compared but not accepted`)
      assert.notEqual(matcherFromArgType({ name, value: ['a'] }).kind, 'none', `${name} is listed as compared but compares nothing`)
    }
    for (const name of ARGTYPE_TYPE_NAMES) {
      if (ARGTYPE_COMPARED_TYPE_NAMES.includes(name)) continue
      assert.equal(matcherFromArgType({ name }).kind, 'none', `${name} is listed as uncompared but states a requirement`)
    }
  })
})

/**
 * Every refusal in the contract reader, and the consequence of each.
 *
 * `member-invalid` and `component-invalid` cover a dozen separate decisions,
 * and a rule id firing somewhere is not a decision being defended. Each guard
 * below was removed on its own and the whole suite stayed green, while the
 * report the CLI produced changed: a different rule id, a different pointer,
 * or -- for the `argTypes` key -- a member named with characters that render
 * as nothing walking into the compared surface and being reported as an
 * addition, which is the README's "refused rather than rendered blank"
 * guarantee failing on the one side of the document nothing was watching.
 */
describe('every refusal in the contract reader is reachable, and says what it refused', () => {
  const STRIPPED = `${String.fromCharCode(0x01)}${String.fromCharCode(0x85)}${String.fromCharCode(0x200e)}`
  const ONE_MEMBER = `export interface ButtonProps {
  label: string;
}
`

  const CASES = [
    {
      what: 'argTypes that is not an object',
      component: componentEntry({ props: undefined, events: undefined, argTypes: 'abc' }),
      ruleId: 'component-invalid',
      pointer: '/components/0/argTypes',
    },
    {
      what: 'an argTypes key that renders as nothing',
      component: componentEntry({
        props: undefined,
        events: undefined,
        argTypes: { [STRIPPED]: { type: { name: 'string', required: true } } },
      }),
      ruleId: 'member-invalid',
    },
    {
      what: 'an argTypes key carrying whitespace',
      component: componentEntry({
        props: undefined,
        events: undefined,
        argTypes: { 'a b': { type: { name: 'string', required: true } } },
      }),
      ruleId: 'member-invalid',
    },
    {
      what: 'an argTypes entry that is not an object',
      component: componentEntry({ props: undefined, events: undefined, argTypes: { label: 'string' } }),
      ruleId: 'member-invalid',
      pointer: '/components/0/argTypes/label',
    },
    {
      what: 'an argTypes type that is not an object',
      component: componentEntry({ props: undefined, events: undefined, argTypes: { label: { type: 'string' } } }),
      ruleId: 'member-invalid',
      pointer: '/components/0/argTypes/label/type',
    },
    {
      what: 'a declared member that is not an object',
      component: componentEntry({ props: ['label'], events: undefined }),
      ruleId: 'member-invalid',
      pointer: '/components/0/props/0',
    },
    {
      what: 'a propsType this tool cannot name',
      component: componentEntry({ propsType: STRIPPED, events: undefined }),
      ruleId: 'component-invalid',
      pointer: '/components/0/propsType',
    },
  ]

  for (const item of CASES) {
    test(`${item.what} is refused, and nothing is compared`, async () => {
      const root = await caseRoot(contractDocument({ components: [item.component] }), ONE_MEMBER)
      const { code, report } = await reportFor(root)

      assert.equal(code, 1)
      const finding = report.findings.find((entry) => entry.ruleId === item.ruleId)
      assert.ok(
        finding,
        `expected ${item.ruleId}, got ${[...new Set(report.findings.map((entry) => entry.ruleId))].join(', ')}`,
      )
      if (item.pointer !== undefined) assert.equal(finding.location.pointer, item.pointer)

      // The consequence. Each of these guards, removed, left a DIFFERENT rule
      // firing or a member reaching the comparison; asserting the rule id
      // alone would not have noticed.
      assert.equal(report.summary.componentsCompared, 0, 'a component with a refused member is not compared')
      assert.equal(report.summary.publicMembers, 0)
      for (const ruleId of ['prop-added', 'prop-missing', 'prop-now-required', 'prop-type-unconstrained',
                            'props-type-missing', 'component-unknown-field']) {
        assert.equal(
          report.findings.some((entry) => entry.ruleId === ruleId),
          false,
          `${ruleId} is a claim about a surface this run never established`,
        )
      }
    })
  }

  test('a component entry that is not an object is refused before its fields are read', async () => {
    const root = await caseRoot(contractDocument({ components: ['Button'] }), ONE_MEMBER)
    const { code, report } = await reportFor(root)
    assert.equal(code, 1)
    const finding = report.findings.find((entry) => entry.ruleId === 'component-invalid')
    assert.ok(finding)
    assert.equal(finding.location.pointer, '/components/0')
    assert.equal(
      report.findings.some((entry) => entry.ruleId === 'component-unknown-field'),
      false,
      'a string has no fields to be unknown, and reading it for them reports nonsense',
    )
  })

  /**
   * One refusal per member, not one per field of it.
   *
   * The `continue` after an unusable free-text field is what stops the rest of
   * the entry being read and reported as well. Removing it left the suite green
   * while an entry with an unusable `name` AND an unreadable `type` produced
   * two findings where one describes the entry.
   */
  test('an entry with more than one thing wrong is refused once, at the first thing', async () => {
    const root = await caseRoot(
      contractDocument({
        components: [componentEntry({
          props: undefined,
          events: undefined,
          argTypes: { label: { name: STRIPPED, type: 'notanobject' } },
        })],
      }),
      ONE_MEMBER,
    )
    const { code, report } = await reportFor(root)
    assert.equal(code, 1)
    const invalid = report.findings.filter((entry) => entry.ruleId === 'member-invalid')
    assert.equal(invalid.length, 1, `one refusal per member: got ${invalid.map((e) => e.location.pointer).join(', ')}`)
    assert.equal(invalid[0].location.pointer, '/components/0/argTypes/label/name')
  })

  test('and the same contract written properly is compared, so none of this refuses everything', async () => {
    const root = await caseRoot(
      contractDocument({
        components: [componentEntry({
          props: undefined,
          events: undefined,
          argTypes: { label: { type: { name: 'string', required: true } } },
        })],
      }),
      ONE_MEMBER,
    )
    const { code, report } = await reportFor(root)
    assert.equal(code, 0)
    assert.equal(report.summary.componentsCompared, 1)
    assert.equal(report.summary.publicMembers, 1)
    assert.equal(report.summary.membersMatched, 1)
  })
})

/**
 * A matcher is described by what it IS, not by text it does not carry.
 *
 * `describeMatcher` has a branch per kind, and the `callable` and `union`
 * branches could each be deleted with the suite green: a `none` and an `exact`
 * matcher carry a `source` string to fall back on and those two do not, so the
 * evidence quietly became `contract: ` with nothing after it. The evidence is
 * the half of the finding that says what the contract asked for.
 */
describe('the evidence names what the contract required', () => {
  test('a function requirement reads as one, rather than as nothing', async () => {
    const root = await caseRoot(
      contractDocument({
        components: [componentEntry({
          props: undefined,
          events: undefined,
          argTypes: { onClick: { type: { name: 'function', required: true } } },
        })],
      }),
      `export interface ButtonProps {
  onClick: string;
}
`,
    )
    const { code, report } = await reportFor(root)
    assert.equal(code, 1)
    const finding = report.findings.find((entry) => entry.ruleId === 'event-type-changed')
    assert.ok(finding)
    assert.equal(finding.evidence, 'contract: a function; source line 2: string')
  })

  test('an enum requirement lists its values, rather than as nothing', async () => {
    const root = await caseRoot(
      contractDocument({
        components: [componentEntry({
          props: undefined,
          events: undefined,
          argTypes: { tone: { type: { name: 'enum', value: ['a', 'b'], required: true } } },
        })],
      }),
      `export interface ButtonProps {
  tone: 'a' | 'c';
}
`,
    )
    const { code, report } = await reportFor(root)
    assert.equal(code, 1)
    const finding = report.findings.find((entry) => entry.ruleId === 'prop-type-changed')
    assert.ok(finding)
    assert.equal(finding.evidence, "contract: 'a' | 'b'; source line 2: 'a'|'c'")
  })
})
