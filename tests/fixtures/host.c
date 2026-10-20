#ifdef __APPLE__
#include <dispatch/dispatch.h>
#else
#include <unistd.h>
#endif

/* A process for tests to spawn into. On Darwin its main thread drains the main dispatch queue, so a
 * @MainActor hop completes as it would in an app with a running main runloop. */
int
main (void)
{
#ifdef __APPLE__
  dispatch_main ();
#else
  pause ();
#endif
  return 0;
}
