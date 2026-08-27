import { cookies } from "next/headers";
import { ADMIN_SESSION_COOKIE, verifySessionToken } from "@/lib/auth";
import LoginForm from "./LoginForm";
import AdminDashboard from "./AdminDashboard";

export default async function AdminPage() {
  const cookieStore = await cookies();
  const authenticated = verifySessionToken(cookieStore.get(ADMIN_SESSION_COOKIE)?.value);

  return authenticated ? <AdminDashboard /> : <LoginForm />;
}
