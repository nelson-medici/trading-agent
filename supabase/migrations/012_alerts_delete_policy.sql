-- Allow authenticated users to delete alerts from the portal
create policy "authenticated delete alerts"
  on alerts for delete
  to authenticated
  using (true);
