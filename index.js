'use strict'

const fs = require('node:fs')
const path = require('node:path')

const PLUGIN_ID = 'autopilot-emulator-v2'
const STATE_FILE_NAME = 'controller-state.json'
const STATE_FILE_VERSION = 1

const STATE_STANDBY = 'standby'
const STATE_AUTO = 'auto'

const MODES = ['compass', 'gps', 'route', 'windApparent', 'windTrue']
const WIND_MODES = new Set(['windApparent', 'windTrue'])
const PATH_OPTION_NAMES = [
  'headingPath',
  'coursePath',
  'routeTrackTruePath',
  'routeTrackMagneticPath',
  'routeBearingMagneticPath',
  'routeXtePath',
  'magneticVariationPath',
  'apparentWindAnglePath',
  'trueWindAnglePath',
  'outputPath',
  'errorPath'
]

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
  const restored = loadControllerState(app, options)
  let state = restored.state
  let selectedMode = restored.mode
  let target = restored.target
  let dodgeBaseTarget = restored.dodgeBaseTarget

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
      persistState()
      ensureTargetForMode()
      publishAutopilot()
      publishOutput()
    },
    getTarget: async () => getInfo().target,
    setTarget: async (value) => {
      assertNumber(value, 'target')
      assertEngaged(state, 'set target')
      assertWritableTargetMode(selectedMode, 'set target')
      target = normalizeTargetForMode(value, selectedMode)
      dodgeBaseTarget = null
      persistState()
      publishAutopilot()
      publishOutput()
    },
    adjustTarget: async (value) => {
      assertNumber(value, 'target adjustment')
      assertEngaged(state, 'adjust target')
      assertWritableTargetMode(selectedMode, 'adjust target')
      ensureTargetForMode()
      target = adjustedTargetForMode(target ?? 0, value, selectedMode)
      dodgeBaseTarget = null
      persistState()
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
      assertEngaged(state, 'tack')
      assertWindMode(selectedMode, 'tack')
      setWindTargetSide(direction)
      persistState()
      publishAutopilot()
      publishOutput()
    },
    gybe: async (direction) => {
      assertEngaged(state, 'gybe')
      assertWindMode(selectedMode, 'gybe')
      setWindTargetSide(direction)
      persistState()
      publishAutopilot()
      publishOutput()
    },
    dodge: async (value) => {
      assertEngaged(state, 'dodge')
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
        target = adjustedTargetForMode(dodgeBaseTarget ?? 0, value, selectedMode)
      }
      persistState()
      publishAutopilot()
      publishOutput()
    },
    courseCurrentPoint: async () => {
      const routeTarget = readRouteTarget(app, options)
      if (routeTarget === null) {
        throw commandError('Route data unavailable', 409)
      }
      selectedMode = 'route'
      target = normalizeTargetForMode(routeTarget, selectedMode)
      dodgeBaseTarget = null
      engage()
    },
    courseNextPoint: async () => {
      assertEngaged(state, 'advance course point')
      if (selectedMode !== 'route') {
        throw commandError('Cannot advance course point outside route mode', 409)
      }
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
      target: engaged ? target : null
    }
  }

  function getActions(engaged) {
    const windMode = WIND_MODES.has(selectedMode)
    const routeAvailable = readRouteTarget(app, options) !== null
    return [
      { id: 'dodge', name: 'Dodge', available: engaged },
      { id: 'tack', name: 'Tack', available: engaged && windMode },
      { id: 'gybe', name: 'Gybe', available: engaged && windMode },
      {
        id: 'courseCurrentPoint',
        name: 'Steer to current course point',
        available: routeAvailable
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
    persistState()
    publishAutopilot()
    publishOutput()
  }

  function disengage() {
    state = STATE_STANDBY
    target = null
    dodgeBaseTarget = null
    persistState()
    publishAutopilot()
    publishOutput()
  }

  function persistState() {
    saveControllerState(app, {
      state,
      mode: selectedMode,
      target:
        state === STATE_AUTO && selectedMode !== 'route'
          ? target
          : null,
      dodgeBaseTarget:
        state === STATE_AUTO && selectedMode !== 'route'
          ? dodgeBaseTarget
          : null
    })
  }

  function ensureTargetForMode() {
    if (selectedMode === 'route') {
      const routeTarget = readRouteTarget(app, options)
      if (routeTarget !== null) {
        target = normalizeTargetForMode(routeTarget, selectedMode)
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
        return normalizeTargetForMode(routeTarget, selectedMode)
      }
    }
    const current = readCurrentAngle(app, options, selectedMode)
    return current === null
      ? defaultTargetForMode(selectedMode)
      : normalizeTargetForMode(current, selectedMode)
  }

  function setWindTargetSide(direction) {
    if (direction !== 'port' && direction !== 'starboard') {
      throw new Error(`Invalid direction: ${direction}`)
    }
    ensureTargetForMode()
    const magnitude = Math.abs(target ?? defaultTargetForMode(selectedMode))
    target = normalizeTargetForMode(
      direction === 'starboard' ? magnitude : -magnitude,
      selectedMode
    )
    dodgeBaseTarget = null
  }

  function publishAutopilot() {
    refreshTargetForMode()
    if (typeof app.autopilotUpdate !== 'function') {
      return
    }
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
        target = normalizeTargetForMode(routeTarget, selectedMode)
      }
    }
  }

  return {
    provider,
    getInfo,
    publishAutopilot,
    publishOutput,
    stop() {
      persistState()
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

function loadControllerState(app, options) {
  const defaults = {
    state: STATE_STANDBY,
    mode: options.defaultMode,
    target: null,
    dodgeBaseTarget: null
  }
  const filename = controllerStatePath(app)
  if (filename === null) {
    return defaults
  }

  try {
    const persisted = JSON.parse(fs.readFileSync(filename, 'utf8'))
    if (
      !persisted ||
      persisted.version !== STATE_FILE_VERSION ||
      (persisted.state !== STATE_STANDBY && persisted.state !== STATE_AUTO) ||
      !MODES.includes(persisted.mode)
    ) {
      return defaults
    }

    if (persisted.state === STATE_STANDBY) {
      return {
        state: STATE_STANDBY,
        mode: persisted.mode,
        target: null,
        dodgeBaseTarget: null
      }
    }
    if (persisted.mode === 'route') {
      return {
        state: STATE_AUTO,
        mode: persisted.mode,
        target: null,
        dodgeBaseTarget: null
      }
    }
    if (typeof persisted.target !== 'number' || !Number.isFinite(persisted.target)) {
      return defaults
    }

    return {
      state: STATE_AUTO,
      mode: persisted.mode,
      target: normalizeTargetForMode(persisted.target, persisted.mode),
      dodgeBaseTarget:
        typeof persisted.dodgeBaseTarget === 'number' &&
        Number.isFinite(persisted.dodgeBaseTarget)
          ? normalizeTargetForMode(persisted.dodgeBaseTarget, persisted.mode)
          : null
    }
  } catch (error) {
    if (error.code !== 'ENOENT') {
      app.debug?.(`${PLUGIN_ID} could not restore controller state: ${error.message}`)
    }
    return defaults
  }
}

function saveControllerState(app, controllerState) {
  const filename = controllerStatePath(app)
  if (filename === null) {
    return
  }

  const data = {
    version: STATE_FILE_VERSION,
    state: controllerState.state,
    mode: controllerState.mode,
    target: controllerState.target,
    dodgeBaseTarget: controllerState.dodgeBaseTarget
  }
  const temporaryFilename = `${filename}.tmp`
  try {
    fs.mkdirSync(path.dirname(filename), { recursive: true })
    fs.writeFileSync(temporaryFilename, JSON.stringify(data, null, 2))
    fs.renameSync(temporaryFilename, filename)
  } catch (error) {
    try {
      fs.unlinkSync(temporaryFilename)
    } catch (_) {
      // The temporary file may not have been created.
    }
    app.debug?.(`${PLUGIN_ID} could not save controller state: ${error.message}`)
  }
}

function controllerStatePath(app) {
  if (typeof app.getDataDirPath !== 'function') {
    return null
  }
  try {
    const dataDir = app.getDataDirPath()
    return typeof dataDir === 'string' && dataDir !== ''
      ? path.join(dataDir, STATE_FILE_NAME)
      : null
  } catch (error) {
    app.debug?.(`${PLUGIN_ID} could not access plugin data directory: ${error.message}`)
    return null
  }
}

function normalizeOptions(props) {
  const options = { ...DEFAULTS, ...props }
  if (!MODES.includes(options.defaultMode)) {
    options.defaultMode = DEFAULTS.defaultMode
  }
  options.updateIntervalMs = numberAtLeast(
    options.updateIntervalMs,
    DEFAULTS.updateIntervalMs,
    100
  )
  options.gain = positiveNumber(options.gain, DEFAULTS.gain)
  options.maxTurnRate = positiveNumber(options.maxTurnRate, DEFAULTS.maxTurnRate)
  options.deviceId = nonEmptyString(options.deviceId, DEFAULTS.deviceId)
  options.routeXteLookahead = numberAtLeast(
    options.routeXteLookahead,
    DEFAULTS.routeXteLookahead,
    1
  )
  options.routeMaxXteCorrection = positiveNumber(
    options.routeMaxXteCorrection,
    DEFAULTS.routeMaxXteCorrection
  )
  for (const optionName of PATH_OPTION_NAMES) {
    options[optionName] = DEFAULTS[optionName]
  }
  return options
}

function positiveNumber(value, fallback) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? value
    : fallback
}

function numberAtLeast(value, fallback, minimum) {
  return typeof value === 'number' && Number.isFinite(value) && value >= minimum
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

function assertEngaged(state, action) {
  if (state !== STATE_AUTO) {
    throw commandError(`Cannot ${action} while autopilot is in standby`, 409)
  }
}

function assertWritableTargetMode(mode, action) {
  if (mode === 'route') {
    throw commandError(`Cannot ${action} in route mode`, 409)
  }
}

function assertNumber(value, label) {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`Invalid ${label}: ${value}`)
  }
}

function commandError(message, statusCode = 400) {
  const error = new Error(message)
  error.statusCode = statusCode
  return error
}

function normalizeTargetForMode(value, mode) {
  const normalize = WIND_MODES.has(mode) ? normalizePi : normalizeTau
  return normalize(roundToDegrees(normalize(value)))
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

function roundToDegrees(radians) {
  return degToRad(Math.round(radians / degToRad(1)))
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
