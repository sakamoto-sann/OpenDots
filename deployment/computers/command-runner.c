// One unprivileged subreaper per bounded shell command. Detached descendants
// remain in this command scope and are terminated before stdout closes.
#include <errno.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <sys/prctl.h>
#include <sys/wait.h>
#include <time.h>
#include <unistd.h>

static void terminate_children(void) {
  char path[100];
  snprintf(path, sizeof(path), "/proc/self/task/%ld/children", (long)getpid());
  FILE *children = fopen(path, "r");
  if (!children) return;
  long child;
  while (fscanf(children, "%ld", &child) == 1)
    if (child > 1) kill((pid_t)child, SIGKILL);
  fclose(children);
}

int main(int argc, char **argv) {
  if (argc != 2 || prctl(PR_SET_CHILD_SUBREAPER, 1) < 0) return 125;
  const pid_t parent = getppid();
  if (prctl(PR_SET_PDEATHSIG, SIGKILL) < 0 || getppid() != parent) return 125;
  pid_t child = fork();
  if (child < 0) return 125;
  if (child == 0) {
    execl("/bin/sh", "sh", "-c", argv[1], (char *)NULL);
    _exit(127);
  }
  int status;
  while (waitpid(child, &status, 0) < 0) {
    if (errno != EINTR) return 125;
  }
  // Killing a direct descendant reparents its descendants here. Repeat until
  // the kernel reports no children, including commands that called setsid().
  for (int attempt = 0; attempt < 1000; attempt++) {
    terminate_children();
    int remaining;
    pid_t done;
    do { done = waitpid(-1, &remaining, WNOHANG); } while (done > 0);
    if (done < 0 && errno == ECHILD)
      return WIFEXITED(status) ? WEXITSTATUS(status) : 128 + WTERMSIG(status);
    struct timespec pause = {0, 10000000};
    nanosleep(&pause, NULL);
  }
  return 125; // The HTTP deadline still retires the entire PID namespace.
}
