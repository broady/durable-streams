import { useCallback, useRef, useState } from "react"
import { useLocation } from "@tanstack/react-router"
import { useStreamDB } from "../lib/stream-db-context"
import { presenceStateSchema } from "../lib/schemas"

export function useTypingIndicator(streamPath: string | undefined) {
  const { presenceStream, userId, sessionId, userColor } = useStreamDB()
  const location = useLocation()
  const [isTyping, setIsTyping] = useState(false)
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | undefined>(
    undefined
  )

  const startTyping = useCallback(() => {
    if (!streamPath) return

    setIsTyping(true)

    // Send typing event
    const presenceEvent = presenceStateSchema.collections.presence.update({
      key: sessionId,
      value: {
        userId,
        route: location.pathname,
        streamPath,
        isTyping: true,
        lastSeen: Date.now(),
        color: userColor,
        sessionId,
      },
    })
    void presenceStream.append(presenceEvent)

    // Clear previous timeout
    if (timeoutRef.current) {
      clearTimeout(timeoutRef.current)
    }

    // Stop typing after 3 seconds of inactivity
    timeoutRef.current = setTimeout(() => {
      setIsTyping(false)
      const stopEvent = presenceStateSchema.collections.presence.update({
        key: sessionId,
        value: {
          userId,
          route: location.pathname,
          streamPath,
          isTyping: false,
          lastSeen: Date.now(),
          color: userColor,
          sessionId,
        },
      })
      void presenceStream.append(stopEvent)
    }, 3000)
  }, [
    streamPath,
    userId,
    sessionId,
    userColor,
    location.pathname,
    presenceStream,
  ])

  return { startTyping, isTyping }
}
