// Imports every module's registrations with Core (realtime channel rules, share resolvers and policies,
// file owner resolvers, erasure participants). Routes that consult those registries import this file.
import '@/modules/jb/register';
import '@/modules/fh/register';
