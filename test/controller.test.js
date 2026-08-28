'use strict'

const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')
const assert = require('node:assert/strict')

const {
  _internals: {
    createController,
    calculateOutput,
    degToRad,
    DEFAULTS,
    adjustedTargetForMode,
    normalizeOptions,
    readCurrentAngle,
    readRouteTarget
  }
} = require('../index')

test('starts in standby with clean v2 options', async () => {
  const app = fakeApp()
  const controller = createController(app, DEFAULTS)

  assert.deepEqual(await controller.provider.getData('virtual'), {
    options: {
      states: [
        { name: 'standby', engaged: false },
        { name: 'auto', engaged: true }
      ],
      modes: ['compass', 'gps', 'route', 'windApparent', 'windTrue'],
      actions: [
        { id: 'dodge', name: 'Dodge', available: false },
        { id: 'tack', name: 'Tack', available: false },
        { id: 'gybe', name: 'Gybe', available: false },
        {
          id: 'courseCurrentPoint',
          name: 'Steer to current course point',
          available: false
        },
        {
          id: 'courseNextPoint',
          name: 'Advance to next course point',
          available: false
        }
      ]
    },
    state: 'standby',
    mode: null,
    engaged: false,
    target: null
  })
})

test('engage initializes compass target from current heading', async () => {
  const app = fakeApp({
    'navigation.headingMagnetic.value': degToRad(123)
  })
  const controller = createController(app, DEFAULTS)

  await controller.provider.engage('virtual')
  const data = await controller.provider.getData('virtual')

  assert.equal(data.state, 'auto')
  assert.equal(data.mode, 'compass')
  assert.equal(data.engaged, true)
  assertNear(data.target, degToRad(123))
})

test('heading controller commands starboard turn for positive heading error', () => {
  const app = fakeApp({
    'navigation.headingMagnetic.value': degToRad(10)
  })
  const output = calculateOutput(app, DEFAULTS, {
    engaged: true,
    mode: 'compass',
    target: degToRad(20)
  })

  assertNear(output.error, degToRad(10))
  assertNear(output.turnRate, degToRad(10) * DEFAULTS.gain)
})

test('heading controller does not fall back to GPS course in compass mode', () => {
  const app = fakeApp({
    'navigation.courseOverGroundTrue.value': degToRad(10)
  })
  const output = calculateOutput(app, DEFAULTS, {
    engaged: true,
    mode: 'compass',
    target: degToRad(20)
  })

  assert.deepEqual(output, { turnRate: 0, error: null })
})

test('gps mode uses configured course input', () => {
  const app = fakeApp({
    'navigation.courseOverGroundTrue.value': degToRad(10)
  })
  const output = calculateOutput(app, DEFAULTS, {
    engaged: true,
    mode: 'gps',
    target: degToRad(20)
  })

  assertNear(output.error, degToRad(10))
  assertNear(output.turnRate, degToRad(10) * DEFAULTS.gain)
})

test('switching to compass captures current magnetic heading', async () => {
  const app = fakeApp({
    'navigation.headingMagnetic.value': degToRad(123),
    'environment.wind.angleApparent.value': degToRad(35)
  })
  const controller = createController(app, {
    ...DEFAULTS,
    defaultMode: 'windApparent'
  })

  await controller.provider.engage('virtual')
  await controller.provider.setTarget(degToRad(40), 'virtual')
  await controller.provider.setMode('compass', 'virtual')
  const data = await controller.provider.getData('virtual')
  const output = lastOutput(app)

  assert.equal(data.mode, 'compass')
  assertNear(data.target, degToRad(123))
  assertNear(output.error, 0)
  assertNear(output.turnRate, 0)
})

test('switching to apparent wind captures current wind angle', async () => {
  const app = fakeApp({
    'navigation.headingMagnetic.value': degToRad(10),
    'environment.wind.angleApparent.value': degToRad(35)
  })
  const controller = createController(app, DEFAULTS)

  await controller.provider.engage('virtual')
  await controller.provider.setTarget(degToRad(90), 'virtual')
  await controller.provider.setMode('windApparent', 'virtual')
  const data = await controller.provider.getData('virtual')
  const output = lastOutput(app)

  assert.equal(data.mode, 'windApparent')
  assertNear(data.target, degToRad(35))
  assertNear(output.error, 0)
  assertNear(output.turnRate, 0)
})

test('switching to true wind captures current wind angle', async () => {
  const app = fakeApp({
    'navigation.headingMagnetic.value': degToRad(10),
    'environment.wind.angleTrueWater.value': -degToRad(42)
  })
  const controller = createController(app, DEFAULTS)

  await controller.provider.engage('virtual')
  await controller.provider.setTarget(degToRad(90), 'virtual')
  await controller.provider.setMode('windTrue', 'virtual')
  const data = await controller.provider.getData('virtual')
  const output = lastOutput(app)

  assert.equal(data.mode, 'windTrue')
  assertNear(data.target, -degToRad(42))
  assertNear(output.error, 0)
  assertNear(output.turnRate, 0)
})

test('positive wind target adjustment commands starboard on port tack', async () => {
  const app = fakeApp({
    'environment.wind.angleApparent.value': -degToRad(35)
  })
  const controller = createController(app, {
    ...DEFAULTS,
    defaultMode: 'windApparent'
  })

  await controller.provider.engage('virtual')
  await controller.provider.adjustTarget(degToRad(10), 'virtual')
  const data = await controller.provider.getData('virtual')
  const output = lastOutput(app)

  assertNear(data.target, -degToRad(45))
  assertNear(output.error, -degToRad(10))
  assertNear(output.turnRate, degToRad(10) * DEFAULTS.gain)
})

test('positive wind dodge commands starboard on port tack and restores target', async () => {
  const app = fakeApp({
    'environment.wind.angleApparent.value': -degToRad(35)
  })
  const controller = createController(app, {
    ...DEFAULTS,
    defaultMode: 'windApparent'
  })

  await controller.provider.engage('virtual')
  await controller.provider.dodge(degToRad(10), 'virtual')
  let data = await controller.provider.getData('virtual')
  let output = lastOutput(app)

  assertNear(data.target, -degToRad(45))
  assertNear(output.turnRate, degToRad(10) * DEFAULTS.gain)

  await controller.provider.dodge(null, 'virtual')
  data = await controller.provider.getData('virtual')
  output = lastOutput(app)

  assertNear(data.target, -degToRad(35))
  assertNear(output.turnRate, 0)
})

test('positive wind target adjustment commands starboard on starboard tack', async () => {
  const app = fakeApp({
    'environment.wind.angleApparent.value': degToRad(35)
  })
  const controller = createController(app, {
    ...DEFAULTS,
    defaultMode: 'windApparent'
  })

  await controller.provider.engage('virtual')
  await controller.provider.adjustTarget(degToRad(10), 'virtual')
  const data = await controller.provider.getData('virtual')
  const output = lastOutput(app)

  assertNear(data.target, degToRad(25))
  assertNear(output.error, -degToRad(10))
  assertNear(output.turnRate, degToRad(10) * DEFAULTS.gain)
})

test('compass target adjustment remains numerically positive to starboard', async () => {
  const app = fakeApp({
    'navigation.headingMagnetic.value': degToRad(35)
  })
  const controller = createController(app, DEFAULTS)

  await controller.provider.engage('virtual')
  await controller.provider.adjustTarget(degToRad(10), 'virtual')
  const data = await controller.provider.getData('virtual')
  const output = lastOutput(app)

  assertNear(data.target, degToRad(45))
  assertNear(output.error, degToRad(10))
  assertNear(output.turnRate, degToRad(10) * DEFAULTS.gain)
})

test('rounds captured and adjusted targets to whole degrees', async () => {
  const app = fakeApp({
    'navigation.headingMagnetic.value': degToRad(150.3),
    'environment.wind.angleApparent.value': -degToRad(35.6),
    'navigation.course.calcValues.bearingTrackTrue.value': degToRad(89.6)
  })
  const controller = createController(app, DEFAULTS)

  await controller.provider.engage('virtual')
  assertNear((await controller.provider.getData('virtual')).target, degToRad(150))

  await controller.provider.setTarget(degToRad(150.6), 'virtual')
  assertNear((await controller.provider.getData('virtual')).target, degToRad(151))

  await controller.provider.setMode('windApparent', 'virtual')
  assertNear((await controller.provider.getData('virtual')).target, -degToRad(36))

  await controller.provider.setMode('route', 'virtual')
  assertNear((await controller.provider.getData('virtual')).target, degToRad(90))
})

test('courseCurrentPoint engages route mode', async () => {
  const app = fakeApp({
    'navigation.course.calcValues.bearingTrackTrue.value': degToRad(90),
    'navigation.headingMagnetic.value': degToRad(80),
    'navigation.magneticVariation.value': degToRad(5)
  })
  const controller = createController(app, DEFAULTS)

  await controller.provider.courseCurrentPoint('virtual')
  const data = await controller.provider.getData('virtual')

  assert.equal(data.state, 'auto')
  assert.equal(data.mode, 'route')
  assertNear(data.target, degToRad(85))
  assert.equal(
    data.options.actions.find((action) => action.id === 'courseNextPoint')
      .available,
    true
  )
})

test('courseCurrentPoint without route data is rejected', async () => {
  const app = fakeApp({
    'environment.wind.angleTrueWater.value': -degToRad(50),
    'navigation.headingMagnetic.value': degToRad(123)
  })
  const controller = createController(app, {
    ...DEFAULTS,
    defaultMode: 'windTrue'
  })

  await controller.provider.engage('virtual')
  assertNear((await controller.provider.getData('virtual')).target, -degToRad(50))

  await assert.rejects(
    () => controller.provider.courseCurrentPoint('virtual'),
    /Route data unavailable/
  )
  const data = await controller.provider.getData('virtual')

  assert.equal(data.mode, 'windTrue')
  assertNear(data.target, -degToRad(50))
})

test('courseNextPoint is unavailable after disengaging route mode', async () => {
  const app = fakeApp({
    'navigation.headingMagnetic.value': degToRad(123),
    'navigation.course.calcValues.bearingTrackTrue.value': degToRad(90),
    'navigation.magneticVariation.value': degToRad(5)
  })
  const controller = createController(app, DEFAULTS)

  await controller.provider.courseCurrentPoint('virtual')
  await controller.provider.disengage('virtual')
  const data = await controller.provider.getData('virtual')

  assert.equal(data.state, 'standby')
  assert.equal(data.target, null)
  assert.equal(
    data.options.actions.find((action) => action.id === 'courseNextPoint')
      .available,
    false
  )
})

test('route target is read-only', async () => {
  const app = fakeApp({
    'navigation.headingMagnetic.value': degToRad(80),
    'navigation.course.calcValues.bearingTrackTrue.value': degToRad(90),
    'navigation.magneticVariation.value': degToRad(5)
  })
  const controller = createController(app, DEFAULTS)

  await controller.provider.courseCurrentPoint('virtual')

  await assert.rejects(
    () => controller.provider.setTarget(degToRad(100), 'virtual'),
    /Cannot set target in route mode/
  )
  await assert.rejects(
    () => controller.provider.adjustTarget(degToRad(10), 'virtual'),
    /Cannot adjust target in route mode/
  )
  assertNear((await controller.provider.getData('virtual')).target, degToRad(85))
})

test('route target applies cross-track correction', () => {
  const app = fakeApp({
    'navigation.course.calcValues.bearingTrackTrue.value': degToRad(90),
    'navigation.course.calcValues.crossTrackError.value': 100
  })
  const target = readRouteTarget(app, DEFAULTS)

  assertNear(target, degToRad(90) - Math.atan(1))
})

test('route target converts true track to magnetic with variation', () => {
  const app = fakeApp({
    'navigation.course.calcValues.bearingTrackTrue.value': degToRad(90),
    'navigation.magneticVariation.value': degToRad(5)
  })
  const target = readRouteTarget(app, DEFAULTS)

  assertNear(target, degToRad(85))
})

test('route target uses magnetic fallback as magnetic', () => {
  const app = fakeApp({
    'navigation.course.calcValues.bearingTrackMagnetic.value': degToRad(90),
    'navigation.magneticVariation.value': degToRad(5)
  })
  const target = readRouteTarget(app, DEFAULTS)

  assertNear(target, degToRad(90))
})

test('route mode controls heading toward dynamic route target', () => {
  const app = fakeApp({
    'navigation.headingMagnetic.value': degToRad(80),
    'navigation.course.calcValues.bearingTrackTrue.value': degToRad(90),
    'navigation.magneticVariation.value': degToRad(5)
  })
  const output = calculateOutput(app, DEFAULTS, {
    engaged: true,
    mode: 'route',
    target: readRouteTarget(app, DEFAULTS)
  })

  assertNear(output.error, degToRad(5))
  assertNear(output.turnRate, degToRad(5) * DEFAULTS.gain)
})

test('input reader accepts a Signal K path object as well as a value path', () => {
  const app = fakeApp({
    'navigation.headingMagnetic.value': {
      value: degToRad(42)
    }
  })

  assertNear(readCurrentAngle(app, DEFAULTS, 'compass'), degToRad(42))
})

test('heading controller saturates turn-rate output', () => {
  const app = fakeApp({
    'navigation.headingMagnetic.value': degToRad(0)
  })
  const output = calculateOutput(app, DEFAULTS, {
    engaged: true,
    mode: 'compass',
    target: degToRad(180)
  })

  assert.equal(output.turnRate, DEFAULTS.maxTurnRate)
})

test('wind controller uses opposite sign because wind angle is relative to bow', () => {
  const app = fakeApp({
    'environment.wind.angleApparent.value': degToRad(30)
  })
  const output = calculateOutput(app, DEFAULTS, {
    engaged: true,
    mode: 'windApparent',
    target: degToRad(40)
  })

  assertNear(output.error, degToRad(10))
  assertNear(output.turnRate, -degToRad(10) * DEFAULTS.gain)
})

test('wind target adjustment is helm-directional, not signed-angle addition', () => {
  assertNear(
    adjustedTargetForMode(-degToRad(35), degToRad(10), 'windApparent'),
    -degToRad(45)
  )
  assertNear(
    adjustedTargetForMode(degToRad(35), degToRad(10), 'windApparent'),
    degToRad(25)
  )
  assertNear(
    adjustedTargetForMode(degToRad(35), degToRad(10), 'compass'),
    degToRad(45)
  )
})

test('standby publishes zero output', () => {
  const app = fakeApp({
    'navigation.headingMagnetic.value': degToRad(0)
  })
  const output = calculateOutput(app, DEFAULTS, {
    engaged: false,
    mode: null,
    target: degToRad(90)
  })

  assert.deepEqual(output, { turnRate: 0, error: null })
})

test('disengage clears exposed mode and target', async () => {
  const app = fakeApp({
    'navigation.headingMagnetic.value': degToRad(35)
  })
  const controller = createController(app, DEFAULTS)

  await controller.provider.engage('virtual')
  await controller.provider.disengage('virtual')
  const data = await controller.provider.getData('virtual')

  assert.equal(data.state, 'standby')
  assert.equal(data.mode, null)
  assert.equal(data.target, null)
  assert.equal(await controller.provider.getTarget('virtual'), null)
})

test('restores the active mode and target after a Signal K restart', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'autopilot-emulator-v2-'))
  try {
    const firstApp = fakeApp(
      { 'environment.wind.angleApparent.value': degToRad(30) },
      dataDir
    )
    const firstController = createController(firstApp, DEFAULTS)

    await firstController.provider.engage('virtual')
    await firstController.provider.setMode('windApparent', 'virtual')
    await firstController.provider.setTarget(degToRad(-42), 'virtual')
    firstController.stop()

    const secondApp = fakeApp(
      { 'environment.wind.angleApparent.value': degToRad(-35) },
      dataDir
    )
    const secondController = createController(secondApp, DEFAULTS)
    const restored = await secondController.provider.getData('virtual')

    assert.equal(restored.state, 'auto')
    assert.equal(restored.mode, 'windApparent')
    assert.equal(restored.engaged, true)
    assertNear(restored.target, degToRad(-42))
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true })
  }
})

test('restores an in-progress dodge and its return target', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'autopilot-emulator-v2-'))
  try {
    const firstController = createController(
      fakeApp({ 'navigation.headingMagnetic.value': degToRad(30) }, dataDir),
      DEFAULTS
    )
    await firstController.provider.engage('virtual')
    await firstController.provider.setTarget(degToRad(40), 'virtual')
    await firstController.provider.dodge(degToRad(10), 'virtual')
    firstController.stop()

    const secondController = createController(
      fakeApp({ 'navigation.headingMagnetic.value': degToRad(30) }, dataDir),
      DEFAULTS
    )
    assertNear((await secondController.provider.getData('virtual')).target, degToRad(50))

    await secondController.provider.dodge(null, 'virtual')
    assertNear((await secondController.provider.getData('virtual')).target, degToRad(40))
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true })
  }
})

test('restores route mode from the current route instead of a stale target', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'autopilot-emulator-v2-'))
  try {
    const firstApp = fakeApp(
      {
        'navigation.headingMagnetic.value': degToRad(80),
        'navigation.course.calcValues.bearingTrackTrue.value': degToRad(90)
      },
      dataDir
    )
    const firstController = createController(firstApp, DEFAULTS)
    await firstController.provider.courseCurrentPoint('virtual')
    firstController.stop()

    const secondApp = fakeApp(
      {
        'navigation.headingMagnetic.value': degToRad(110),
        'navigation.course.calcValues.bearingTrackTrue.value': degToRad(120)
      },
      dataDir
    )
    const secondController = createController(secondApp, DEFAULTS)
    secondController.publishAutopilot()
    const restored = await secondController.provider.getData('virtual')

    assert.equal(restored.state, 'auto')
    assert.equal(restored.mode, 'route')
    assertNear(restored.target, degToRad(120))
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true })
  }
})

test('ignores invalid persisted controller state', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'autopilot-emulator-v2-'))
  try {
    fs.writeFileSync(
      path.join(dataDir, 'controller-state.json'),
      JSON.stringify({ version: 1, state: 'auto', mode: 'compass', target: 'invalid' })
    )
    const controller = createController(fakeApp({}, dataDir), DEFAULTS)
    const data = await controller.provider.getData('virtual')

    assert.equal(data.state, 'standby')
    assert.equal(data.mode, null)
    assert.equal(data.target, null)
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true })
  }
})

test('standby rejects active target and maneuver commands', async () => {
  const app = fakeApp({
    'navigation.headingMagnetic.value': degToRad(35),
    'environment.wind.angleApparent.value': degToRad(35)
  })
  const controller = createController(app, DEFAULTS)

  await assert.rejects(
    () => controller.provider.setTarget(degToRad(40), 'virtual'),
    /Cannot set target while autopilot is in standby/
  )
  await assert.rejects(
    () => controller.provider.adjustTarget(degToRad(10), 'virtual'),
    /Cannot adjust target while autopilot is in standby/
  )
  await assert.rejects(
    () => controller.provider.dodge(degToRad(10), 'virtual'),
    /Cannot dodge while autopilot is in standby/
  )
  await assert.rejects(
    () => controller.provider.tack('port', 'virtual'),
    /Cannot tack while autopilot is in standby/
  )
  await assert.rejects(
    () => controller.provider.courseNextPoint('virtual'),
    /Cannot advance course point while autopilot is in standby/
  )
})

test('normalizes configured minimums', () => {
  assert.equal(normalizeOptions({ updateIntervalMs: 0 }).updateIntervalMs, 1000)
  assert.equal(normalizeOptions({ updateIntervalMs: 100 }).updateIntervalMs, 100)
  assert.equal(normalizeOptions({ routeXteLookahead: 0 }).routeXteLookahead, 100)
  assert.equal(normalizeOptions({ routeXteLookahead: 1 }).routeXteLookahead, 1)
})

test('keeps Signal K paths fixed to their defaults', () => {
  const pathOptions = Object.keys(DEFAULTS).filter((name) => name.endsWith('Path'))
  const configured = normalizeOptions(
    Object.fromEntries(pathOptions.map((name) => [name, `custom.${name}`]))
  )
  const schema = require('../index')({}).schema()

  for (const name of pathOptions) {
    assert.equal(configured[name], DEFAULTS[name])
    assert.equal(name in schema.properties, false)
  }
})

test('tack sets wind target side', async () => {
  const app = fakeApp({
    'environment.wind.angleApparent.value': degToRad(35)
  })
  const controller = createController(app, {
    ...DEFAULTS,
    defaultMode: 'windApparent'
  })

  await controller.provider.engage('virtual')
  await controller.provider.tack('port', 'virtual')
  assertNear((await controller.provider.getData('virtual')).target, -degToRad(35))

  await controller.provider.tack('starboard', 'virtual')
  assertNear((await controller.provider.getData('virtual')).target, degToRad(35))
})

function fakeApp(paths = {}, dataDir) {
  return {
    getSelfPath(path) {
      return paths[path]
    },
    autopilotUpdate(deviceId, data) {
      this.autopilotUpdates.push({ deviceId, data })
    },
    handleMessage(source, delta) {
      this.messages.push({ source, delta })
    },
    getDataDirPath() {
      return dataDir
    },
    autopilotUpdates: [],
    messages: []
  }
}

function assertNear(actual, expected, epsilon = 1e-12) {
  assert.equal(Math.abs(actual - expected) < epsilon, true)
}

function lastOutput(app) {
  const message = app.messages.at(-1)
  const values = message.delta.updates[0].values
  return {
    turnRate: values.find((entry) => entry.path === DEFAULTS.outputPath).value,
    error: values.find((entry) => entry.path === DEFAULTS.errorPath).value
  }
}
