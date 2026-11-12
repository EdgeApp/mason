import { createContext, useContext, type JSX, type ReactNode } from 'react'
import { ApiClient } from './client.js'

const ApiContext = createContext<ApiClient | undefined>(undefined)

/** Gives the app its one typed client. */
export function ApiProvider({
  client,
  children,
}: {
  client: ApiClient
  children: ReactNode
}): JSX.Element {
  return <ApiContext.Provider value={client}>{children}</ApiContext.Provider>
}

/** The app's typed client. */
export function useApi(): ApiClient {
  const client = useContext(ApiContext)
  if (client == null) throw new Error('useApi needs an ApiProvider')
  return client
}
