/**
 * Email system placeholder — wire to SendGrid / Resend / Nodemailer for:
 * - Welcome email on signup
 * - Order confirmation
 */
export async function sendWelcomeEmail({ to, name }) {
  console.log('[email:placeholder] welcome →', to, name);
  return { ok: true, placeholder: true };
}

export async function sendOrderConfirmationEmail({ to, name, orderId, total }) {
  console.log('[email:placeholder] order confirmation →', to, name, orderId, total);
  return { ok: true, placeholder: true };
}
