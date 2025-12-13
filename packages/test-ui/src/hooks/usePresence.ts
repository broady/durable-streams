import { useEffect } from "react"
import { useLocation, useParams } from "@tanstack/react-router"
import { useStreamDB } from "../lib/stream-db-context"
import { presenceStateSchema } from "../lib/schemas"

export function usePresence() {
  const { presenceStream, userId, sessionId, userColor } = useStreamDB()
  const location = useLocation()
  const params = useParams({ strict: false })

  // Update presence on route change
  useEffect(() => {
    const updatePresence = async () => {
      const presenceEvent = presenceStateSchema.collections.presence.update({
        key: sessionId,
        value: {
          userId,
          route: location.pathname,
          streamPath: (params as any).streamPath,
          isTyping: false,
          lastSeen: Date.now(),
          color: userColor,
          sessionId,
        },
      })

      await presenceStream.append(presenceEvent)
    }

    void updatePresence()
  }, [
    location.pathname,
    (params as any).streamPath,
    userId,
    sessionId,
    userColor,
    presenceStream,
  ])

  // Heartbeat every 50 seconds
  useEffect(() => {
    const interval = setInterval(async () => {
      const presenceEvent = presenceStateSchema.collections.presence.update({
        key: sessionId,
        value: {
          userId,
          route: location.pathname,
          streamPath: (params as any).streamPath,
          isTyping: false,
          lastSeen: Date.now(),
          color: userColor,
          sessionId,
        },
      })

      await presenceStream.append(presenceEvent)
    }, 50000)

    return () => clearInterval(interval)
  }, [
    location.pathname,
    (params as any).streamPath,
    userId,
    sessionId,
    userColor,
    presenceStream,
  ])

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      const presenceEvent = presenceStateSchema.collections.presence.delete({
        key: sessionId,
      })
      void presenceStream.append(presenceEvent)
    }
  }, [sessionId, presenceStream])
}
