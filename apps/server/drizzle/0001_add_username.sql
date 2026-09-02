ALTER TABLE `users` ADD `username` varchar(24);--> statement-breakpoint
UPDATE `users` SET `username` = CONCAT(SUBSTRING(REGEXP_REPLACE(LOWER(SUBSTRING_INDEX(`email`, '@', 1)), '[^a-z0-9_]', ''), 1, 15), '_', SUBSTRING(REPLACE(`id`, '-', ''), 1, 8)) WHERE `username` IS NULL;--> statement-breakpoint
ALTER TABLE `users` MODIFY COLUMN `username` varchar(24) NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX `users_username_unique` ON `users` (`username`);
