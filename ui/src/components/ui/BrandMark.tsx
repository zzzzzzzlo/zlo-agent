export function BrandMark({ size = 26 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 40 40" fill="none" aria-hidden="true">
      <path d="M7 29C11 33 34 23 34 14C34 8 23 10 15 15C6 20 3 26 7 29Z" stroke="currentColor" strokeWidth="1.6" />
      <path d="M25 6C31 9 28 22 23 30C19 37 12 36 12 30C11 24 15 14 20 8C22 6 24 5 25 6Z" stroke="currentColor" strokeOpacity=".68" strokeWidth="1.4" />
      <circle cx="20" cy="20" r="3.6" fill="currentColor" />
      <circle cx="30.5" cy="11.2" r="1.7" fill="currentColor" />
    </svg>
  )
}
