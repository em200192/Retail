import { Redirect } from 'expo-router';

/** Any unknown address (e.g. when hosted under a sub-path) goes to the start screen. */
export default function NotFound() {
  return <Redirect href="/" />;
}
