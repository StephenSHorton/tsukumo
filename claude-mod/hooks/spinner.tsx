import type { ClientModule } from 'claude-code'

/** Claude Code's spinner glyphs, played forward then back. */
const FRAMES = ['·', '✢', '✳', '✶', '✻', '✽']
const CYCLE = FRAMES.length * 2 - 2

type Props = { color: string }

/** Runs on the surface's own frame clock, so the spark turns without a round trip to the mod. */
const Spinner: ClientModule<Props, number> = (props, surface) => {
  if (surface.state === undefined) {
    surface.setState(0)
    surface.every(120, () => surface.setState(((surface.state ?? 0) + 1) % CYCLE))
  }
  const step = surface.state ?? 0
  const frame = FRAMES[step < FRAMES.length ? step : CYCLE - step] ?? FRAMES[0]
  const { Text } = surface.elements
  return <Text color={props.color}>{frame}</Text>
}

export default Spinner
