#if !defined(__APPLE__) || !defined(__MACH__)
#error "secure-swap barrier launcher is Darwin-only"
#endif

#include <fcntl.h>
#include <unistd.h>

#define HARNESS_CHANNEL_FD 3
#define HELPER_BARRIER_FD 198

extern char **environ;

int main(int argc, char **argv) {
    if (argc != 2 || argv[1] == NULL || argv[1][0] != '/') {
        return 2;
    }
    if (fcntl(HARNESS_CHANNEL_FD, F_GETFD) < 0) {
        return 3;
    }
    if (dup2(HARNESS_CHANNEL_FD, HELPER_BARRIER_FD) < 0) {
        return 4;
    }
    int descriptor_flags = fcntl(HELPER_BARRIER_FD, F_GETFD);
    if (descriptor_flags < 0 ||
        fcntl(HELPER_BARRIER_FD, F_SETFD, descriptor_flags & ~FD_CLOEXEC) < 0) {
        return 5;
    }
    if (HARNESS_CHANNEL_FD != HELPER_BARRIER_FD) {
        close(HARNESS_CHANNEL_FD);
    }
    char *const helper_argv[] = {argv[1], NULL};
    execve(argv[1], helper_argv, environ);
    return 6;
}
