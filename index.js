'use strict'

const PLUGIN_ID = 'autopilot-emulator-v2'

const STATE_STANDBY = 'standby'
const STATE_AUTO = 'auto'

const MODES = ['compass', 'gps', 'route', 'windApparent', 'windTrue']
const WIND_MODES = new Set(['windApparent', 'windTrue'])

const DEFAULTS = {
  deviceId: 'virtual',
  defaultMode: 'compass',
  updateIntervalMs: 1000,
  headingPath: 'navigation.headingMagnetic.value',
  coursePath: 'navigation.courseOverGroundTrue.value',
  routeTrackTruePath: 'navigation.course.calcValues.bearingTrackTrue.value',
  routeTrackMagneticPath: 'navigation.course.calcValues.bearingTrackMagnetic.value',
  routeBearingMagneticPath: 'navigation.course.calcValues.bearingMagnetic.value',
  routeXtePath: 'navigation.course.calcValues.crossTrackError.value',
  magneticVariationPath: 'navigation.magneticVariation.value',
  routeXteLookahead: 100,
  routeMaxXteCorrection: degToRad(60),
  apparentWindAnglePath: 'environment.wind.angleApparent.value',
  trueWindAnglePath: 'environment.wind.angleTrueWater.value',
  outputPath: 'steering.autopilot.output.turnRate',
  errorPath: 'steering.autopilot.output.error',
  gain: 0.3,
  maxTurnRate: degToRad(5)
}

function pluginFactory(app) {
  let timer
  let controller

  const plugin = {
    id: PLUGIN_ID,
    name: 'Autopilot Emulator v2',
    description:
      'Virtual autopilot provider for the Signal K Autopilot API v2',

    schema() {
      return {
        type: 'object',
        title: 'Autopilot Emulator v2',
        properties: {
          deviceId: {
            type: 'string',
            title: 'Autopilot device id',
            default: DEFAULTS.deviceId
          },
          defaultMode: {
            type: 'string',
            title: 'Default steering mode',
            enum: MODES,
            default: DEFAULTS.defaultMode
          },
          updateIntervalMs: {
            type: 'number',
            title: 'Output update interval',
            description: 'Milliseconds between API heartbeat/output updates.',
            default: DEFAULTS.updateIntervalMs,
            minimum: 100
          },
          headingPath: {
            type: 'string',
            title: 'Heading input path',
            default: DEFAULTS.headingPath
          },
          coursePath: {
            type: 'string',
            title: 'GPS course input path',
            default: DEFAULTS.coursePath
          },
          routeTrackTruePath: {
            type: 'string',
            title: 'Route true track input path',
            default: DEFAULTS.routeTrackTruePath
          },
          routeTrackMagneticPath: {
            type: 'string',
            title: 'Route magnetic track fallback path',
            default: DEFAULTS.routeTrackMagneticPath
          },
          routeBearingMagneticPath: {
            type: 'string',
            title: 'Route magnetic bearing fallback path',
            default: DEFAULTS.routeBearingMagneticPath
          },
          routeXtePath: {
            type: 'string',
            title: 'Route cross-track error input path',
            default: DEFAULTS.routeXtePath
          },
          magneticVariationPath: {
            type: 'string',
            title: 'Magnetic variation input path',
            default: DEFAULTS.magneticVariationPath
          },
          routeXteLookahead: {
            type: 'number',
            title: 'Route XTE lookahead distance',
            description:
              'Cross-track error distance, in meters, that produces about half the maximum route correction.',
            default: DEFAULTS.routeXteLookahead,
            minimum: 1
          },
          routeMaxXteCorrection: {
            type: 'number',
            title: 'Route maximum XTE correction',
            description: 'Maximum route correction in radians.',
            default: DEFAULTS.routeMaxXteCorrection,
            minimum: 0
          },
          apparentWindAnglePath: {
            type: 'string',
            title: 'Apparent wind angle input path',
            default: DEFAULTS.apparentWindAnglePath
          },
          trueWindAnglePath: {
            type: 'string',
            title: 'True wind angle input path',
            default: DEFAULTS.trueWindAnglePath
          },
          outputPath: {
            type: 'string',
            title: 'Turn-rate output path',
            default: DEFAULTS.outputPath
          },
          errorPath: {
            type: 'string',
            title: 'Control error output path',
            default: DEFAULTS.errorPath
          },
          gain: {
            type: 'number',
            title: 'Proportional gain',
            description: 'Turn-rate command in rad/s per radian of error.',
            default: DEFAULTS.gain,
            minimum: 0
          },
          maxTurnRate: {
            type: 'number',
            title: 'Maximum turn-rate command',
            description: 'Absolute output limit in rad/s.',
            default: DEFAULTS.maxTurnRate,
            minimum: 0
          }
        }
      }
    },

    start(props = {}) {
      const options = normalizeOptions(props)
      controller = createController(app, options)

      app.registerAutopilotProvider(controller.provider, [options.deviceId])
      publishMetadata(app, options)
      controller.publishAutopilot()
      controller.publishOutput()

      timer = setInterval(() => {
        controller.publishAutopilot()
        controller.publishOutput()
      }, options.updateIntervalMs)

      app.debug?.(`${PLUGIN_ID} registered device ${options.deviceId}`)
    },

    stop() {
      if (timer) {
        clearInterval(timer)
        timer = undefined
      }
      if (controller) {
        controller.stop()
        controller = undefined
      }
    }
  }

  return plugin
}

function createController(app, options) {
  let state = STATE_STANDBY
  let selectedMode = options.defaultMode
  let target = null
  let dodgeBaseTarget = null

  const provider = {
    getData: async () => getInfo(),
    getState: async () => state,
    setState: async (nextState) => {
      assertState(nextState)
      if (nextState === STATE_AUTO) {
        engage()
      } else {
        disengage()
      }
    },
    getMode: async () => getInfo().mode,
    setMode: async (mode) => {
      assertMode(mode)
      selectedMode = mode
      target = readInitialTargetForMode()
      dodgeBaseTarget = null
      ensureTargetForMode()
      publishAutopilot()
      publishOutput()
    },
    getTarget: async () => target,
    setTarget: async (value) => {
      assertNumber(value, 'target')
      target = normalizeTargetForMode(value, selectedMode)
      dodgeBaseTarget = null
      publishAutopilot()
      publishOutput()
    },
    adjustTarget: async (value) => {
      assertNumber(value, 'target adjustment')
      ensureTargetForMode()
      target = adjustedTargetForMode(target ?? 0, value, selectedMode)
      dodgeBaseTarget = null
      publishAutopilot()
      publishOutput()
    },
    engage: async () => {
      engage()
    },
    disengage: async () => {
      disengage()
    },
    tack: async (direction) => {
      assertWindMode(selectedMode, 'tack')
      setWindTargetSide(direction)
      publishAutopilot()
      publishOutput()
    },
    gybe: async (direction) => {
      assertWindMode(selectedMode, 'gybe')
      setWindTargetSide(direction)
      publishAutopilot()
      publishOutput()
    },
    dodge: async (value) => {
      if (value === null) {
        if (dodgeBaseTarget !== null) {
          target = dodgeBaseTarget
          dodgeBaseTarget = null
        }
      } else {
        assertNumber(value, 'dodge value')
        ensureTargetForMode()
        if (dodgeBaseTarget === null) {
          dodgeBaseTarget = target
        }
        target = normalizeTargetForMode((dodgeBaseTarget ?? 0) + value, selectedMode)
      }
      publishAutopilot()
      publishOutput()
    },
    courseCurrentPoint: async () => {
      selectedMode = 'route'
      target = readRouteTarget(app, options)
      dodgeBaseTarget = null
      engage()
    },
    courseNextPoint: async () => {
      // The route provider owns waypoint advancement. The emulator acknowledges
      // the action so client flows can test the round-trip.
    }
  }

  function getInfo() {
    const engaged = state === STATE_AUTO
    return {
      options: {
        states: [
          { name: STATE_STANDBY, engaged: false },
          { name: STATE_AUTO, engaged: true }
        ],
        modes: MODES,
        actions: getActions(engaged)
      },
      state,
      mode: engaged ? selectedMode : null,
      engaged,
      target
    }
  }

  function getActions(engaged) {
    const windMode = WIND_MODES.has(selectedMode)
    return [
      { id: 'dodge', name: 'Dodge', available: engaged },
      { id: 'tack', name: 'Tack', available: engaged && windMode },
      { id: 'gybe', name: 'Gybe', available: engaged && windMode },
      {
        id: 'courseCurrentPoint',
        name: 'Steer to current course point',
        available: true
      },
      {
        id: 'courseNextPoint',
        name: 'Advance to next course point',
        available: engaged && selectedMode === 'route'
      }
    ]
  }

  function engage() {
    state = STATE_AUTO
    ensureTargetForMode()
    publishAutopilot()
    publishOutput()
  }

  function disengage() {
    state = STATE_STANDBY
    dodgeBaseTarget = null
    publishAutopilot()
    publishOutput()
  }

  function ensureTargetForMode() {
    if (selectedMode === 'route') {
      const routeTarget = readRouteTarget(app, options)
      if (routeTarget !== null) {
        target = routeTarget
        return
      }
    }
    if (target !== null) {
      target = normalizeTargetForMode(target, selectedMode)
      return
    }
    target = readInitialTargetForMode()
  }

  function readInitialTargetForMode() {
    if (selectedMode === 'route') {
      const routeTarget = readRouteTarget(app, options)
      if (routeTarget !== null) {
        return routeTarget
      }
    }
    const current = readCurrentAngle(app, options, selectedMode)
    return current === null ? defaultTargetForMode(selectedMode) : current
  }

  function setWindTargetSide(direction) {
    if (direction !== 'port' && direction !== 'starboard') {
      throw new Error(`Invalid direction: ${direction}`)
    }
    ensureTargetForMode()
    const magnitude = Math.abs(target ?? defaultTargetForMode(selectedMode))
    target = direction === 'starboard' ? magnitude : -magnitude
    dodgeBaseTarget = null
  }

  function publishAutopilot() {
    refreshTargetForMode()
    app.autopilotUpdate(options.deviceId, {
      state: getInfo().state,
      mode: getInfo().mode,
      target: getInfo().target,
      engaged: getInfo().engaged,
      actions: getInfo().options.actions
    })
  }

  function publishOutput() {
    refreshTargetForMode()
    const output = calculateOutput(app, options, getInfo())
    app.handleMessage(PLUGIN_ID, {
      updates: [
        {
          values: [
            { path: options.outputPath, value: output.turnRate },
            { path: options.errorPath, value: output.error }
          ]
        }
      ]
    })
  }

  function refreshTargetForMode() {
    if (state === STATE_AUTO && selectedMode === 'route') {
      const routeTarget = readRouteTarget(app, options)
      if (routeTarget !== null) {
        target = routeTarget
      }
    }
  }

  return {
    provider,
    getInfo,
    publishAutopilot,
    publishOutput,
    stop() {
      if (state === STATE_AUTO) {
        state = STATE_STANDBY
        publishAutopilot()
      }
      app.handleMessage(PLUGIN_ID, {
        updates: [
          {
            values: [
              { path: options.outputPath, value: 0 },
              { path: options.errorPath, value: null }
            ]
          }
        ]
      })
    }
  }
}

function calculateOutput(app, options, info) {
  if (!info.engaged || info.mode === null || info.target === null) {
    return { turnRate: 0, error: null }
  }

  const current = readCurrentAngle(app, options, info.mode)
  if (current === null) {
    return { turnRate: 0, error: null }
  }

  const error = normalizePi(info.target - current)
  const sign = WIND_MODES.has(info.mode) ? -1 : 1
  const turnRate = clamp(sign * error * options.gain, -options.maxTurnRate, options.maxTurnRate)
  return { turnRate, error }
}

function readCurrentAngle(app, options, mode) {
  const pathsByMode = {
    compass: [options.headingPath],
    gps: [options.coursePath],
    route: [options.headingPath],
    windApparent: [options.apparentWindAnglePath],
    windTrue: [options.trueWindAnglePath]
  }
  for (const path of unique(pathsByMode[mode] ?? [])) {
    const value = readSelfNumber(app, path)
    if (value !== null) {
      return value
    }
  }
  return null
}

function readRouteTarget(app, options) {
  const magneticVariation = readSelfNumber(app, options.magneticVariationPath)
  const trackTrue = readSelfNumber(app, options.routeTrackTruePath)
  if (trackTrue !== null) {
    return trueHeadingToMagnetic(
      correctedRouteHeading(app, options, trackTrue),
      magneticVariation
    )
  }

  for (const path of unique([
    options.routeTrackMagneticPath,
    options.routeBearingMagneticPath
  ])) {
    const value = readSelfNumber(app, path)
    if (value !== null) {
      return correctedRouteHeading(app, options, value)
    }
  }

  return null
}

function correctedRouteHeading(app, options, trackHeading) {
  const xte = readSelfNumber(app, options.routeXtePath)
  if (xte === null) {
    return normalizeTau(trackHeading)
  }

  const correction = clamp(
    -Math.atan(xte / options.routeXteLookahead),
    -options.routeMaxXteCorrection,
    options.routeMaxXteCorrection
  )
  return normalizeTau(trackHeading + correction)
}

function readSelfNumber(app, path) {
  const raw = app.getSelfPath?.(path)
  if (typeof raw === 'number' && Number.isFinite(raw)) {
    return raw
  }
  if (
    raw &&
    typeof raw === 'object' &&
    typeof raw.value === 'number' &&
    Number.isFinite(raw.value)
  ) {
    return raw.value
  }
  return null
}

function publishMetadata(app, options) {
  app.handleMessage(PLUGIN_ID, {
    updates: [
      {
        meta: [
          {
            path: options.outputPath,
            value: {
              displayName: 'Autopilot commanded turn rate',
              description:
                'Virtual autopilot output. Positive values command a turn to starboard.',
              units: 'rad/s'
            }
          },
          {
            path: options.errorPath,
            value: {
              displayName: 'Autopilot control error',
              description:
                'Signed angular error used by the virtual autopilot controller.',
              units: 'rad'
            }
          }
        ]
      }
    ]
  })
}

function normalizeOptions(props) {
  const options = { ...DEFAULTS, ...props }
  if (!MODES.includes(options.defaultMode)) {
    options.defaultMode = DEFAULTS.defaultMode
  }
  options.updateIntervalMs = positiveNumber(
    options.updateIntervalMs,
    DEFAULTS.updateIntervalMs
  )
  options.gain = positiveNumber(options.gain, DEFAULTS.gain)
  options.maxTurnRate = positiveNumber(options.maxTurnRate, DEFAULTS.maxTurnRate)
  options.deviceId = nonEmptyString(options.deviceId, DEFAULTS.deviceId)
  options.headingPath = nonEmptyString(options.headingPath, DEFAULTS.headingPath)
  options.coursePath = nonEmptyString(options.coursePath, DEFAULTS.coursePath)
  options.routeTrackTruePath = nonEmptyString(
    options.routeTrackTruePath,
    DEFAULTS.routeTrackTruePath
  )
  options.routeTrackMagneticPath = nonEmptyString(
    options.routeTrackMagneticPath,
    DEFAULTS.routeTrackMagneticPath
  )
  options.routeBearingMagneticPath = nonEmptyString(
    options.routeBearingMagneticPath,
    DEFAULTS.routeBearingMagneticPath
  )
  options.routeXtePath = nonEmptyString(
    options.routeXtePath,
    DEFAULTS.routeXtePath
  )
  options.magneticVariationPath = nonEmptyString(
    options.magneticVariationPath,
    DEFAULTS.magneticVariationPath
  )
  options.routeXteLookahead = positiveNumber(
    options.routeXteLookahead,
    DEFAULTS.routeXteLookahead
  )
  options.routeMaxXteCorrection = positiveNumber(
    options.routeMaxXteCorrection,
    DEFAULTS.routeMaxXteCorrection
  )
  options.apparentWindAnglePath = nonEmptyString(
    options.apparentWindAnglePath,
    DEFAULTS.apparentWindAnglePath
  )
  options.trueWindAnglePath = nonEmptyString(
    options.trueWindAnglePath,
    DEFAULTS.trueWindAnglePath
  )
  options.outputPath = nonEmptyString(options.outputPath, DEFAULTS.outputPath)
  options.errorPath = nonEmptyString(options.errorPath, DEFAULTS.errorPath)
  return options
}

function positiveNumber(value, fallback) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? value
    : fallback
}

function nonEmptyString(value, fallback) {
  return typeof value === 'string' && value.trim() !== '' ? value : fallback
}

function unique(values) {
  return [...new Set(values.filter((value) => typeof value === 'string'))]
}

function assertState(state) {
  if (state !== STATE_STANDBY && state !== STATE_AUTO) {
    throw new Error(`Invalid state: ${state}`)
  }
}

function assertMode(mode) {
  if (!MODES.includes(mode)) {
    throw new Error(`Invalid mode: ${mode}`)
  }
}

function assertWindMode(mode, action) {
  if (!WIND_MODES.has(mode)) {
    throw new Error(`Cannot ${action} in ${mode} mode`)
  }
}

function assertNumber(value, label) {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`Invalid ${label}: ${value}`)
  }
}

function normalizeTargetForMode(value, mode) {
  return WIND_MODES.has(mode) ? normalizePi(value) : normalizeTau(value)
}

function adjustedTargetForMode(target, adjustment, mode) {
  const signedAdjustment = WIND_MODES.has(mode) ? -adjustment : adjustment
  return normalizeTargetForMode(target + signedAdjustment, mode)
}

function defaultTargetForMode(mode) {
  return WIND_MODES.has(mode) ? degToRad(45) : 0
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value))
}

function normalizePi(value) {
  let result = normalizeTau(value + Math.PI) - Math.PI
  if (result <= -Math.PI) {
    result += Math.PI * 2
  }
  return result
}

function normalizeTau(value) {
  const tau = Math.PI * 2
  return ((value % tau) + tau) % tau
}

function degToRad(degrees) {
  return degrees * (Math.PI / 180)
}

function trueHeadingToMagnetic(headingTrue, magneticVariation) {
  if (magneticVariation === null) {
    return normalizeTau(headingTrue)
  }
  return normalizeTau(headingTrue - magneticVariation)
}

module.exports = pluginFactory
module.exports._internals = {
  createController,
  calculateOutput,
  normalizeOptions,
  readCurrentAngle,
  readRouteTarget,
  adjustedTargetForMode,
  normalizePi,
  normalizeTau,
  degToRad,
  DEFAULTS,
  MODES
}
